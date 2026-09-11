import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I, FileIcon } from "../components/Icons";
import { ViewerModal } from "../components/ViewerModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { DocumentMeta } from "../../shared/types";
import { loadConfig, graphIndexModel } from "../lib/config";
import { embeddingProfileOf } from "../../shared/embeddingProfile";
import { useActionGuard } from "../lib/useActionGuard";
import { fetchDocuments, uploadDocumentStreaming, deleteDocument, deleteManyDocuments, deleteAllDocuments, reindexDocument, buildGraph, formatBytes, type UploadStageEvent } from "../lib/api";

/** 同时处理的最大文件数（其余排队自动补位） */
const MAX_CONCURRENT = 3;

type JobStatus = "queued" | "running" | "done" | "error";

interface Job {
  key: string;
  name: string;
  size: number;
  ext: string;             // 原始扩展名（可能非法）
  status: JobStatus;
  /** 展示用 0-100：上传阶段 0-35（真实字节），处理阶段 35-100（服务端事件） */
  pct: number;
  stage: string;           // 阶段文案
  error?: string;
}

/** 待确认的删除动作：单个 / 批量所选 / 一键全部 */
type ConfirmReq =
  | { kind: "one"; doc: DocumentMeta }
  | { kind: "batch"; docs: DocumentMeta[] }
  | { kind: "all" };

export default function DocumentsPage() {
  const activeEmbeddingProfile = embeddingProfileOf(loadConfig().embed);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<DocumentMeta | null>(null);
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // —— 批量选择 / 删除（删除均为真删除） ——
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 权威镜像：防止连点确认在重渲染前穿透 busy 状态重复发删除请求
  const deletingRef = useRef(false);

  // 所有按钮统一防抖/防重入：连点/双击只会触发一次效果
  const guard = useActionGuard();

  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const load = useCallback(() => {
    fetchDocuments().then((list) => {
      setDocs(list);
      // 删除/刷新后清理已失效的选择项（如被删除的文档 id）
      setSel((prev) => {
        if (prev.size === 0) return prev;
        const alive = new Set(list.map((d) => d.id));
        const keep = [...prev].filter((id) => alive.has(id));
        return keep.length === prev.size ? prev : new Set(keep);
      });
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // ===== 并发任务队列 =====
  // jobs 的权威副本放 ref，异步回调/调度器读最新值避免闭包过期；state 只负责渲染
  const jobsRef = useRef<Job[]>([]);
  const fileByKey = useRef<Map<string, File>>(new Map());
  const runningRef = useRef(0);
  const retireTimer = useRef<number | null>(null);

  const syncJobs = useCallback((next: Job[]) => {
    jobsRef.current = next;
    setJobs(next);
  }, []);
  const patchJob = useCallback((key: string, p: Partial<Job>) => {
    syncJobs(jobsRef.current.map((j) => (j.key === key ? { ...j, ...p } : j)));
  }, [syncJobs]);
  const removeJob = useCallback((key: string) => {
    syncJobs(jobsRef.current.filter((j) => j.key !== key));
  }, [syncJobs]);

  const retireDone = useCallback(() => {
    if (retireTimer.current !== null) return;
    retireTimer.current = window.setTimeout(() => {
      retireTimer.current = null;
      syncJobs(jobsRef.current.filter((j) => j.status !== "done"));
      const live = jobsRef.current.some((j) => j.status === "queued" || j.status === "running");
      if (!live) load();
    }, 1600);
  }, [syncJobs, load]);

  // 执行单个文件：XHR 真实上传进度 + NDJSON 服务端阶段事件
  const runOne = useCallback(async (key: string) => {
    const file = fileByKey.current.get(key);
    if (!file) return;
    const cfg = loadConfig();
    try {
      await uploadDocumentStreaming(file, cfg, {
        onUpload: (pct) => patchJob(key, { stage: `上传中 ${pct}%`, pct: Math.min(35, Math.round(pct * 0.35)) }),
        onStage: (ev: UploadStageEvent) => {
          // 服务端 pct 0-100 映射到 35-99
          const server = typeof ev.pct === "number" ? ev.pct : 0;
          const label = ev.label || stageFallback(ev.stage);
          patchJob(key, { stage: label, pct: Math.min(99, Math.round(35 + server * 0.64)) });
        },
      });
      patchJob(key, { status: "done", pct: 100, stage: "索引完成" });
      retireDone();
    } catch (e) {
      patchJob(key, { status: "error", stage: "失败", error: (e as Error).message || "上传失败" });
    } finally {
      runningRef.current = Math.max(0, runningRef.current - 1);
      fileByKey.current.delete(key);
      kickRef.current();
    }
  }, [patchJob, retireDone]);

  // 调度器：空位就取最早 queued 任务开跑（runOne 的 finally 会再次补位）
  const kick = useCallback(() => {
    while (runningRef.current < MAX_CONCURRENT) {
      const next = jobsRef.current.find((j) => j.status === "queued");
      if (!next) break;
      runningRef.current += 1;
      patchJob(next.key, { status: "running", pct: 0, stage: "等待服务端连接…" });
      void runOne(next.key);
    }
  }, [patchJob, runOne]);
  const kickRef = useRef(kick);
  kickRef.current = kick;

  // —— 批量上传入口：非法格式直接生成错误行，其余排队 → 调度器补位 ——
  const enqueue = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const cfg = loadConfig();
    if (!cfg.embed.apiKey) { showToast("请先在「设置」中配置 Embedding API Key"); return; }
    const allowed = ["pdf", "docx", "txt"];
    const fresh: Job[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const key = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      if (!allowed.includes(ext)) {
        fresh.push({ key, name: file.name, size: file.size, ext, status: "error", pct: 0, stage: "格式不支持", error: "仅支持 PDF / DOCX / TXT（.doc 请先另存为 .docx）" });
        continue;
      }
      fileByKey.current.set(key, file);
      fresh.push({ key, name: file.name, size: file.size, ext, status: "queued", pct: 0, stage: "排队中…" });
    }
    if (fresh.length === 0) return;
    syncJobs([...jobsRef.current, ...fresh]);
    kickRef.current();
  }, [showToast, syncJobs]);

  const retryJob = useCallback((key: string) => {
    patchJob(key, { status: "queued", pct: 0, stage: "排队中…", error: undefined });
    kickRef.current();
  }, [patchJob]);

  // ===== 批量选择 / 删除 =====
  const clearSel = () => setSel(new Set());
  const toggleSel = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // 「全选」作用于当前列表（含搜索过滤后的结果）；已全选时再点则取消
  const selectAllVisible = () => {
    const ids = filtered.map((d) => d.id);
    if (ids.length === 0) return;
    setSel((prev) => {
      const all = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) { if (all) next.delete(id); else next.add(id); }
      return next;
    });
  };

  // —— 请求删除：先弹自定义确认框（替代原生 window.confirm） ——
  const askDelete = (d: DocumentMeta) => setConfirm({ kind: "one", doc: d });
  const askBatchDelete = () => {
    const list = docs.filter((d) => sel.has(d.id));
    if (list.length === 0) return;
    setConfirm({ kind: "batch", docs: list });
  };
  const askDeleteAll = () => {
    if (docs.length === 0) return;
    setConfirm({ kind: "all" });
  };

  /** 确认后执行：服务端级联删除向量索引 + 图谱 + 本地原始文件（真删除） */
  const execDelete = async (req: ConfirmReq) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      if (req.kind === "one") {
        setBusyId(req.doc.id);
        await deleteDocument(req.doc.id);
        showToast(`已删除「${req.doc.name}」`);
      } else if (req.kind === "batch") {
        const r = await deleteManyDocuments(req.docs.map((d) => d.id));
        showToast(`已删除 ${r.deleted} 个文档`);
        clearSel();
      } else {
        const r = await deleteAllDocuments();
        // 清空后取消仍在排队的上传，避免它们随后又把新文件写回库
        syncJobs(jobsRef.current.filter((j) => j.status !== "queued"));
        showToast(r.deleted > 0 ? `已清空文档库（共删除 ${r.deleted} 个文档）` : "文档库已经是空的");
        clearSel();
      }
      load();
    } catch (e) {
      showToast((e as Error).message);
      load();
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setBusyId(null);
      setConfirm(null);
    }
  };

  const reindex = async (d: DocumentMeta) => {
    const cfg = loadConfig();
    if (!cfg.embed.apiKey) { showToast("请先在「设置」中配置 Embedding API Key"); return; }
    setBusyId(d.id);
    try {
      const r = await reindexDocument(d.id, cfg);
      const g = r.graphStatus === "ready" ? `（图谱 ${r.entityCount ?? 0} 实体）` : r.graphStatus === "failed" ? "（图谱失败）" : "";
      showToast(`✓ 重新索引完成，共 ${r.chunks} 块${g}`);
      load();
    } catch (e) { showToast((e as Error).message); load(); }
    finally { setBusyId(null); }
  };

  const doGraph = async (d: DocumentMeta) => {
    const cfg = loadConfig();
    if (!graphIndexModel(cfg)) { showToast("补建图谱需要先在「设置」配置对话模型或索引模型"); return; }
    setBusyId(d.id);
    try {
      const r = await buildGraph(d.id, cfg);
      showToast(`✓ 图谱构建完成：${r.entities} 实体 / ${r.relations} 关系`);
      load();
    } catch (e) { showToast((e as Error).message); load(); }
    finally { setBusyId(null); }
  };

  const openViewer = (d: DocumentMeta) => setViewer(d);
  const pickFile = () => fileRef.current?.click();

  const filtered = docs.filter((d) => d.name.toLowerCase().includes(query.toLowerCase()));
  const totalChunks = docs.reduce((s, d) => s + d.chunkCount, 0);
  const jobStats = useMemo(() => ({
    running: jobs.filter((j) => j.status === "running").length,
    queued: jobs.filter((j) => j.status === "queued").length,
  }), [jobs]);

  return (
    <div className="content">
      <div className="page-head">
        <h1 className="font-tech">文档库<small>管理你的知识资产</small></h1>
        <div className="stats">
          <div className="stat"><b>{docs.length}</b><span>文档总数</span></div>
          <div className="stat"><b>{totalChunks}</b><span>文本块</span></div>
          <div className="stat"><b>{formatBytes(docs.reduce((s, d) => s + d.size, 0))}</b><span>占用空间</span></div>
        </div>
        <button className="btn-primary" onClick={() => guard("pick", pickFile)}><I.Plus />上传文档</button>
      </div>

      <div
        className={"dropzone" + (dragging ? " drag" : "")}
        onClick={() => guard("pick", pickFile)}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); guard("upload", enqueue, e.dataTransfer.files); }}
      >
        <div className="dz-icon"><I.Upload size={20} /></div>
        <h3>拖拽文件到此处，或 <b>点击选择文件</b></h3>
        <p>一次可选择多个文件：同时最多 {MAX_CONCURRENT} 个在上传/解析，其余自动排队，每个文件独立显示进度</p>
        <div className="fmts"><span className="fmt pdf">PDF</span><span className="fmt docx">DOCX</span><span className="fmt txt">TXT</span><span className="fmt" style={{ color: "var(--dim)" }}>DOC 需先另存为 DOCX</span></div>
      </div>
      <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" multiple hidden onChange={(e) => { guard("upload", enqueue, e.target.files); e.target.value = ""; }} />

      {/* —— 批量任务行：每个文件一行、独立进度 —— */}
      {jobs.length > 0 && (
        <div className="q-wrap">
          <div className="sec-head">
            <h2><span className="bar" />上传任务
              {(jobStats.running > 0 || jobStats.queued > 0) && (
                <small style={{ fontSize: 11, color: "var(--dim)", fontWeight: 400 }}>
                  {jobStats.running} 个处理中{jobStats.queued > 0 ? ` · ${jobStats.queued} 个排队` : ""}
                </small>
              )}
            </h2>
          </div>
          <div className="job-list">
            {jobs.map((j, i) => {
              const queuedAhead = jobs.slice(0, i).filter((x) => x.status === "queued").length;
              return (
                <div key={j.key} className={"job-row" + (j.status === "error" ? " err" : j.status === "done" ? " ok" : "")}>
                  <div className={"file-icon " + j.ext}><FileIcon type={j.ext === "txt" ? "txt" : j.ext === "pdf" ? "pdf" : "docx"} size={16} /></div>
                  <div className="job-main">
                    <div className="job-top">
                      <span className="job-name" title={j.name}>{j.name}</span>
                      <span className="job-size">{formatBytes(j.size)}</span>
                      <span className={"st " + (j.status === "error" ? "st-fail" : j.status === "done" ? "st-ready" : j.status === "running" ? "st-index" : "")}>
                        {j.status === "queued" ? "排队中" : j.status === "running" ? "处理中" : j.status === "done" ? "已完成" : "失败"}
                      </span>
                    </div>
                    {j.status !== "error" && (
                      <div className="progress">
                        <div className="bar"><i style={{ width: j.pct + "%", transition: "width .4s" }} /></div>
                        <div className="t">
                          <span>{j.status === "queued" ? (queuedAhead > 0 ? `排队中（前面 ${queuedAhead} 个）` : "准备开始…") : j.stage}</span>
                          <span>{j.status === "done" ? "100%" : j.pct + "%"}</span>
                        </div>
                      </div>
                    )}
                    {j.error && <div className="err-msg"><I.Alert />{j.error}</div>}
                    {(j.status === "error" || j.status === "queued") && (
                      <div className="job-actions">
                        {j.status === "error" && <button className="act primary" onClick={() => guard("retry:" + j.key, retryJob, j.key)}><I.Refresh size={12} />重试</button>}
                        <button className="act danger" onClick={() => guard("drop:" + j.key, removeJob, j.key)}><I.Trash size={12} />移除</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="sec-head">
        <h2><span className="bar" />全部文档</h2>
        <div className="tools">
          <div className="search"><I.Search /><input placeholder="搜索文档…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          {sel.size > 0 ? (
            <>
              <span className="sel-count">已选 <b>{sel.size}</b> 个</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={selectAllVisible}
                title="切换选择当前列表中的全部文档"
              >
                {filtered.length > 0 && filtered.every((d) => sel.has(d.id)) ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={deleting}
                onClick={askBatchDelete}
                title="删除所选文档：向量索引、知识图谱与本地原始文件一并永久删除"
              >
                <I.Trash size={13} />批量删除
              </button>
              <button type="button" className="icon-btn" title="清空选择" onClick={clearSel}><I.X /></button>
            </>
          ) : (
            <button
              type="button"
              className="btn-danger-ghost"
              disabled={deleting || docs.length === 0}
              onClick={askDeleteAll}
              title="一键删除文档库中的全部文档：本地原始文件、向量索引与知识图谱会被一并永久删除，此操作不可恢复"
            >
              <I.Trash size={13} />一键删除
            </button>
          )}
        </div>
      </div>

      <div className="grid">
        {filtered.map((d) => {
            const needsReindex = d.status === "ready" && !!d.embeddingProfile && d.embeddingProfile !== activeEmbeddingProfile;
          const picked = sel.has(d.id);
          return (
          <div key={d.id} className={"card" + (picked ? " sel" : "")}>
            <div className="card-top">
              <button
                type="button"
                className={"pick" + (picked ? " on" : "")}
                title={picked ? "取消选择" : "选择此文档（支持批量删除）"}
                onClick={() => toggleSel(d.id)}
              >
                {picked && <I.Check size={12} />}
              </button>
              <div className={"file-icon " + d.type}><FileIcon type={d.type} size={18} /></div>
              <div className="card-info">
                <div className="card-name">{d.name}</div>
                <div className="card-meta">
                  <span><I.Clock size={11} />{formatBytes(d.size)}</span>
                  <span><I.Layers size={11} />{d.chunkCount} 块</span>
                  <span>{new Date(d.createdAt).toLocaleDateString()}</span>
                  {d.graphStatus === "ready" && !!d.entityCount && <span className="gmeta" style={{ color: "var(--ok,#0a7a3d)" }}>图谱 {d.entityCount}</span>}
                  {d.graphStatus === "failed" && <span className="gmeta" style={{ color: "#c0392b" }}>图谱失败</span>}
                  {d.graphStatus === "none" && d.status === "ready" && <span className="gmeta" style={{ color: "var(--dim)" }}>纯向量</span>}
                  {needsReindex && <span className="gmeta" style={{ color: "#c07800" }}>需重建索引</span>}
                </div>
              </div>
              {d.status === "ready" && <span className="st st-ready">就绪</span>}
              {d.status === "processing" && <span className="st st-index">索引中…</span>}
              {d.status === "failed" && <span className="st st-fail">失败</span>}
            </div>
            {d.status === "failed" && d.error && (
              <div className="err-msg"><I.Alert />{d.error}</div>
            )}
            <div className="card-actions">
              <button className="act primary" disabled={busyId === d.id} title="查看原始文档：PDF 内嵌预览，DOCX/TXT 展示提取出的文本，用于核对 AI 回答的出处" onClick={() => guard("view:" + d.id, openViewer, d)}><I.Eye size={12} />打开原文</button>
              <button className="act" disabled={busyId === d.id || d.status === "processing"} title="重新读取留存的原始文件，重新分块并调用 Embedding 重建向量索引（更换了向量模型或上次索引失败后可重试）" onClick={() => guard("reindex:" + d.id, reindex, d)}><I.Refresh size={12} />{needsReindex ? "重建索引" : "重新索引"}</button>
              {d.status === "ready" && (d.graphStatus === "none" || d.graphStatus === "failed") && (
                <button className="act" disabled={busyId === d.id} title="为已就绪文档抽取实体/关系建图谱（消耗对话或索引模型 Token），增强跨文档对比与全局问答" onClick={() => guard("graph:" + d.id, doGraph, d)}><I.Layers size={12} />补建图谱</button>
              )}
              <button className="act danger" disabled={busyId === d.id || deleting} title="真删除：本地原始文件、向量索引与知识图谱一并永久删除" onClick={() => guard("delete:" + d.id, askDelete, d)}><I.Trash size={12} />删除</button>
            </div>
          </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1" }}><I.File size={40} /><p>{docs.length === 0 ? "还没有文档，上传你的第一个文件吧" : "没有匹配的文档"}</p></div>
        )}
      </div>

      {viewer && <ViewerModal doc={viewer} onClose={() => setViewer(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "one" ? "删除文档？" : confirm.kind === "batch" ? "批量删除所选文档？" : "一键删除全部文档？"}
          confirmText={confirm.kind === "one" ? "删除" : confirm.kind === "batch" ? `删除所选 ${confirm.docs.length} 个` : "全部删除"}
          busy={deleting}
          busyText="删除中…"
          onConfirm={() => execDelete(confirm)}
          onCancel={() => setConfirm(null)}
        >
          {confirm.kind === "one" ? (
            <p>将从本地<b>永久删除</b>文档「{confirm.doc.name}」，其向量索引、知识图谱与留存的原始文件一并清除，<b>此操作不可恢复</b>。</p>
          ) : confirm.kind === "batch" ? (
            <>
              <p>将从本地永久删除所选 <b>{confirm.docs.length}</b> 个文档（向量索引、知识图谱与原始文件一并清除），此操作不可恢复：</p>
              <ul className="dlg-names">
                {confirm.docs.slice(0, 4).map((d) => (
                  <li key={d.id}><FileIcon type={d.type} size={12} /><span>{d.name}</span></li>
                ))}
                {confirm.docs.length > 4 && <li className="more">… 及另外 {confirm.docs.length - 4} 个文件</li>}
              </ul>
            </>
          ) : (
            <p>将删除文档库中<b>全部 {docs.length} 个文档</b>：本地保存的原始文件、向量索引与知识图谱都会被<b>永久删除</b>，此操作不可恢复。</p>
          )}
        </ConfirmDialog>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function stageFallback(stage: UploadStageEvent["stage"]): string {
  switch (stage) {
    case "parse": return "解析文档…";
    case "chunk": return "正在分块…";
    case "embed": return "向量化中…";
    case "graph": return "图谱抽取中…";
    case "finalize": return "写入索引…";
    default: return "处理中…";
  }
}
