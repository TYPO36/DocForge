import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { I, FileIcon } from "../components/Icons";
import { ViewerModal } from "../components/ViewerModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { ChatMessage, Citation, DocumentMeta } from "../../shared/types";
import { loadConfig } from "../lib/config";
import { useActionGuard } from "../lib/useActionGuard";
import { streamChat } from "../lib/api";
import { listMeta, getConv, upsertConv, removeConv, activeId, setActiveId, type ConvMeta } from "../lib/history";

const SUGGESTS = [
  { q: "这些文档的核心内容是什么？", d: "对全部已索引文档做整体概括" },
  { q: "找出与「预算」相关的所有段落", d: "按关键词语义检索" },
  { q: "文档里有没有提到具体的截止日期或版本号？", d: "精准定位关键信息" },
  { q: "总结第 1 篇文档的主要结论", d: "单文档深度问答" },
];

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("zh-CN", opts).format(d);
}

export default function ChatPage() {
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [activeIdState, setActiveIdState] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<{ doc: DocumentMeta; highlight?: string; page?: number | null } | null>(null);
  const [toast, setToast] = useState("");
  // 待确认删除的历史会话 id（用自定义确认弹框替代原生 confirm）
  const [delId, setDelId] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);

  // 消息镜像 ref：异步回调（onDone/onError）里能拿到最新消息用于持久化
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeRef = useRef<string | null>(null);

  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  // 按钮防抖/防重入
  const guard = useActionGuard();

  // 初始化：恢复本地保存的历史会话与上次打开的会话
  useEffect(() => {
    setConvs(listMeta());
    const saved = activeId();
    const conv = saved && getConv(saved);
    if (conv) {
      setActiveIdState(saved);
      activeRef.current = saved;
      setMessages(conv.messages);
      messagesRef.current = conv.messages;
    } else {
      const newest = listMeta()[0];
      if (newest) {
        const c = getConv(newest.id);
        setActiveIdState(newest.id);
        activeRef.current = newest.id;
        setActiveId(newest.id);
        if (c) { setMessages(c.messages); messagesRef.current = c.messages; }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 以 ref 为权威同步推进消息状态（异步回调/持久化处能立即拿到最新值） */
  const setMsgs = useCallback((updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    const prev = messagesRef.current;
    const next = typeof updater === "function" ? (updater as (p: ChatMessage[]) => ChatMessage[])(prev) : updater;
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /** 把当前会话写入本地历史（空会话不落库） */
  const persistActive = useCallback(() => {
    const id = activeRef.current;
    if (!id) return;
    upsertConv(id, messagesRef.current);
    setConvs(listMeta());
  }, []);

  useEffect(() => {
    if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy) return;
    const cfg = loadConfig();
    if (!cfg.chat.apiKey || !cfg.embed.apiKey) {
      showToast("请先在「设置」中填写 API Key");
      return;
    }
    // 首次提问时确保存在一个会话
    if (!activeRef.current) {
      const id = uid();
      activeRef.current = id;
      setActiveIdState(id);
      setActiveId(id);
    }
    setInput("");
    const history = messagesRef.current.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((prev) => [...prev, { role: "user", content: q }, { role: "assistant", content: "", citations: [] }]);
    persistActive();
    setBusy(true);
    try {
      await streamChat(q, cfg, history, {
        onDelta: (text) => {
          setMsgs((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + text };
            return next;
          });
        },
        onCitations: (cites) => {
          setMsgs((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") next[next.length - 1] = { ...last, citations: cites };
            return next;
          });
        },
        onDone: () => { setBusy(false); persistActive(); },
        onError: (msg) => {
          setMsgs((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === "assistant" && !last.content) next[next.length - 1] = { ...last, content: "⚠️ " + msg };
            return next;
          });
          setBusy(false);
          persistActive();
        },
      });
    } catch (e) {
      showToast((e as Error).message);
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, busy, messagesRef, setMsgs, persistActive, showToast]);

  /** 会话切换/新建前把当前内容落盘 */
  const saveAndSwitch = useCallback((id: string | null, msgs: ChatMessage[]) => {
    if (busy) { showToast("正在生成中，请先等待回答完成"); return false; }
    persistActive();
    activeRef.current = id;
    setActiveIdState(id);
    if (id) setActiveId(id);
    setMsgs(msgs);
    setInput("");
    return true;
  }, [busy, persistActive, setMsgs, showToast]);

  const newChat = () => {
    saveAndSwitch(uid(), []);
  };

  const selectConv = (id: string) => {
    if (id === activeRef.current) return;
    const c = getConv(id);
    if (!c) return;
    saveAndSwitch(id, c.messages);
  };

  const delConv = (id: string) => {
    if (busy) { showToast("正在生成中，请稍候"); return; }
    setDelId(id); // 先弹自定义确认框，确认后才真删除本地历史
  };

  /** 确认后执行删除：移除本地历史会话，若正在查看则切换到剩余会话或新建空会话 */
  const doDeleteConv = () => {
    const id = delId;
    if (!id) return;
    removeConv(id);
    const rest = listMeta();
    setConvs(rest);
    if (id === activeRef.current) {
      if (rest.length > 0) {
        const c = getConv(rest[0].id);
        activeRef.current = rest[0].id;
        setActiveIdState(rest[0].id);
        setActiveId(rest[0].id);
        setMsgs(c?.messages ?? []);
      } else {
        activeRef.current = null;
        setActiveIdState(null);
        setMsgs([]);
      }
    }
    setDelId(null);
  };

  /** 从引用打开原文：文档信息由引用自身携带（查看文档列表请前往文档库） */
  const openCite = (c: Citation) => {
    const doc: DocumentMeta = {
      id: c.docId, name: c.docName, type: c.type, size: 0,
      status: "ready", chunkCount: 0, error: null, createdAt: new Date(0).toISOString(),
    };
    setViewer({ doc, highlight: c.text, page: c.page });
  };

  /**
   * 渲染回答正文：把 [1]、[1,3] 引用角标拆成右上角小号、异色、可悬浮点击的按钮，
   * 点击跳转原文详情并高亮引用片段；无对应来源的编号保留为不可点击角标。
   */
  const renderRefs = (content: string, cites: Citation[] | undefined, msgIdx: number): ReactNode[] => {
    const nodes: ReactNode[] = [];
    const re = /\[(\d+(?:\s*[,，]\s*\d+)*)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let k = 0;
    while ((m = re.exec(content)) !== null) {
      if (m.index > last) nodes.push(content.slice(last, m.index));
      for (const part of m[1].split(/[,，]/)) {
        const n = parseInt(part, 10);
        if (!Number.isFinite(n)) continue;
        const c = cites && cites[n - 1];
        const key = `ref-${msgIdx}-${k++}`;
        if (c) {
          const pg = c.pages && c.pages.length ? c.pages : c.page ? [c.page] : [];
          nodes.push(
            <button
              key={key}
              type="button"
              className="ref"
              title={`查看原文出处：${c.docName}${pg.length ? `（第 ${pg.join("、")} 页）` : ""} — ${c.text.replace(/\s+/g, " ").slice(0, 80)}…`}
              onClick={() => { const cc = cites?.[n - 1]; if (cc) guard("view:" + cc.docId, openCite, cc); }}
            >{n}</button>,
          );
        } else {
          nodes.push(<span key={key} className="ref ref-miss">{n}</span>);
        }
      }
      last = m.index + m[0].length;
    }
    if (last < content.length) nodes.push(content.slice(last));
    return nodes;
  };

  const copyMsg = (content: string) => {
    navigator.clipboard.writeText(content).then(() => showToast("已复制到剪贴板"));
  };

  const removeMsgAt = (i: number) => {
    setMsgs((prev) => prev.filter((_, k) => k <= i - 1));
    persistActive();
  };

  return (
    <div className="app chat-shell">
      {/* 侧栏：仅历史对话 */}
      <aside className="sidebar">
        <div className="sb-top">
          <button className="new-chat" onClick={() => guard("new-chat", newChat)}><I.Plus />新对话</button>
        </div>
        <div className="sb-scroll">
          <div className="sb-title">历史对话 <span className="count">{convs.length}</span></div>
          {convs.length === 0 ? (
            <div className="sb-empty">暂无历史对话<br />发送第一段提问后会自动保存在这里</div>
          ) : (
            convs.map((c) => (
              <div key={c.id} className={"doc-item conv-item" + (c.id === activeIdState ? " active" : "")} onClick={() => guard("conv:" + c.id, selectConv, c.id)}>
                <div className="doc-icon chat"><I.Chat /></div>
                <div className="doc-meta">
                  <div className="doc-name">{c.title}</div>
                  <div className="doc-sub">{fmtTime(c.updatedAt)} · {c.userCount} 问</div>
                </div>
                <button className="conv-del" title="删除这段历史" onClick={(e) => { e.stopPropagation(); guard("delconv:" + c.id, delConv, c.id); }}><I.Trash size={12} /></button>
              </div>
            ))
          )}
        </div>
        <div className="sb-footer">
          <NavLink to="/documents" className="sb-go-docs"><I.DocGrid size={13} />管理文档，去「文档库」</NavLink>
        </div>
      </aside>

      {/* 主区 */}
      <main className="main">
        <div className="chat-area" ref={areaRef}>
          <div className="chat-inner">
            {messages.length === 0 ? (
              <div className="empty" style={{ paddingTop: 80 }}>
                <div className="logo-mark" style={{ width: 46, height: 46, borderRadius: 13 }}><I.Vector size={20} /></div>
                <h2 className="font-tech" style={{ fontSize: 22, color: "var(--text)" }}>向你的文档提问</h2>
                <p style={{ fontSize: 13, marginBottom: 8 }}>回答基于「文档库」中已索引的文档并附引用来源，点击角标可查看原文</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, maxWidth: 620, width: "100%", marginTop: 12 }}>
                  {SUGGESTS.map((s) => (
                    <button key={s.q} className="card" style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit" }} onClick={() => guard("suggest:" + s.q, setInput, s.q)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span className="file-icon" style={{ width: 24, height: 24 }}><I.Chip size={12} /></span>
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.q}</span>
                      </div>
                      <span style={{ fontSize: 11, color: "var(--dim)" }}>{s.d}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => {
                const streaming = busy && i === messages.length - 1;
                return (
                <div key={i} className={"msg " + m.role}>
                  <div className="avatar">{m.role === "user" ? <I.User size={15} /> : <I.Vector size={15} />}</div>
                  <div className="bubble">
                    {m.content || streaming ? (
                      <>
                        {streaming && !m.content ? (
                          <span className="think">正在检索并生成回答…</span>
                        ) : (
                          renderRefs(streaming ? m.content.replace(/\s+$/g, "") : m.content, m.citations, i)
                        )}
                        {streaming && <span className="cursor" />}
                      </>
                    ) : null}
                    {m.role === "assistant" && !streaming && m.citations && m.citations.length > 0 && (
                      (() => {
                        // 引用来源只对应“回答正文实际标注 [n] 的片段”；
                        // 检索出的 topK 候选不等于回答用到的出处，全部展示会误导（如产品名在多个文档出现）。
                        // 正文没有任何角标（如纯统计/无出处回答）则不渲染引用区。
                        const used = new Set<number>();
                        const re = /\[(\d+(?:\s*[,，]\s*\d+)*)\]/g;
                        let mm: RegExpExecArray | null;
                        const body = m.content || "";
                        while ((mm = re.exec(body)) !== null) {
                          for (const part of mm[1].split(/[,，]/)) {
                            const n = parseInt(part, 10);
                            if (Number.isFinite(n)) used.add(n);
                          }
                        }
                        if (used.size === 0) return null;
                        const indices = m.citations.map((_, j) => j).filter((j) => used.has(j + 1));
                        if (indices.length === 0) return null;
                        return (
                          <div className="cites">
                            <div className="cite-title">引用来源 · {indices.length} 处</div>
                            {indices.map((j) => {
                              const c = m.citations![j];
                              return (
                                <button key={j} className="cite" onClick={() => guard("cite:" + j, openCite, c)}>
                                  <span className="num">{j + 1}</span>
                                  <span className="body">
                                    <span className="file"><FileIcon type={c.type} />{c.docName}
                                    {(c.pages && c.pages.length ? c.pages : c.page ? [c.page] : []).map((p) => (
                                      <span key={p} className="pg">第 {p} 页</span>
                                    ))}
                                  </span>
                                    <span className="snip">{c.text.slice(0, 80)}…</span>
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()
                    )}
                    {m.role === "assistant" && m.content && (
                      <div className="msg-actions">
                        <button className="msg-act" onClick={() => guard("copy:" + i, copyMsg, m.content)}><I.Copy size={12} />复制</button>
                        <button className="msg-act" onClick={() => guard("delmsg:" + i, removeMsgAt, i)}><I.Swap size={12} />删除本条</button>
                      </div>
                    )}
                  </div>
                </div>
                );
              })
            )}
          </div>
        </div>

        <div className="input-wrap">
          <div className="input-box">
            <textarea
              rows={1}
              value={input}
              placeholder="向你的文档提问，例如：文档中关于预算的审批流程是什么？"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); guard("send", send); } }}
            />
            <div className="input-tools">
              <span className="input-meta">Enter 发送 · Shift+Enter 换行</span>
              <button className="send" disabled={busy || !input.trim()} onClick={() => guard("send", send)}><I.Send />{busy ? "生成中…" : "发送"}</button>
            </div>
          </div>
        </div>
      </main>

      {viewer && <ViewerModal doc={viewer.doc} highlight={viewer.highlight} page={viewer.page} onClose={() => setViewer(null)} />}
      {delId && (
        <ConfirmDialog
          title="删除这段历史对话？"
          confirmText="删除"
          onConfirm={doDeleteConv}
          onCancel={() => setDelId(null)}
        >
          <p>将从本机删除历史对话「<b>{convs.find((c) => c.id === delId)?.title ?? ""}</b>」及其中的全部消息，此操作不可恢复。</p>
        </ConfirmDialog>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
