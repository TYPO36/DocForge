import { Hono } from "hono";
import { z } from "zod";
import type { Storage } from "../storage/types";
import type { EmbedConfig } from "../../shared/types";
import { parseFile } from "../services/parser";
import { chunkText } from "../services/chunker";
import { embedTexts, AiError } from "../services/ai";
import { buildDocGraph } from "../services/graph";
import { embedCfgOf, chatCfgOf, indexCfgOf, optionsOf, graphProfileOf } from "../services/reqCfg";
import { validateEmbedConfig, validateFileName, validateOptionalModelConfig } from "../services/requestValidation";
import { embeddingProfileOf } from "../../shared/embeddingProfile";
import { randomUUID } from "node:crypto";

const MAX_MB = Number(process.env.MAX_UPLOAD_MB ?? 20);

interface GraphOutcome {
  status: "none" | "building" | "ready" | "failed";
  error?: string | null;
  entityCount: number;
}

const NONE: GraphOutcome = { status: "none", error: null, entityCount: 0 };

function fileTypeOf(name: string): "pdf" | "docx" | "txt" | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  return null;
}

/**
 * 真删除单个文档：级联清掉向量分块、知识图谱、文档记录，
 * 并直接删除本地/对象存储中留存的原始文件（docs/<id>/<name>）。
 * 幂等：文档不存在时返回 false，不报错。
 */
async function purgeDocument(storage: Storage, id: string): Promise<boolean> {
  const doc = await storage.getDocument(id);
  if (!doc) return false;
  await storage.deleteChunksByDoc(id);
  await storage.deleteGraphByDoc(id);
  await storage.deleteDocument(id);
  await storage.deleteFile("docs/" + id + "/" + doc.name).catch(() => {});
  return true;
}

export function documentsRoutes(storage: Storage) {
  const app = new Hono<{ Variables: { storage: Storage } }>();

  // 上传并建立索引（含可选的图谱抽取）
  // 流式响应：返回 application/x-ndjson，逐行推送真实处理进度；
  //   行格式 {"type":"stage","stage":"parse|chunk|embed|graph|finalize","label":…,"pct":0-100,"done":i,"total":n}
  //        {"type":"done","id":…,"chunks":…,"pages":…,"graphStatus":…,"entityCount":…}
  //        {"type":"error","message":…}
  // 前置校验失败（缺配置/无文件/超限/类型不支持）仍返回普通 JSON 错误，不会进入流。
  app.post("/", async (c) => {
    const embedCfg: EmbedConfig = embedCfgOf(c);
    const embedValidation = validateEmbedConfig(embedCfg);
    if ("error" in embedValidation) return c.json({ error: "Embedding 配置无效：" + embedValidation.error }, 400);
    // 图谱抽取配置：优先独立索引模型，未配则回退 chat 模型（见设置页标注）
    const chatCfg = chatCfgOf(c);
    const indexCfg = indexCfgOf(c);
    const profile = graphProfileOf(chatCfg, indexCfg);
    const opts = optionsOf(c, { rewrite: true, graph: true, rerank: false });
    if (opts.graph && profile) {
      const graphValidation = validateOptionalModelConfig(profile);
      if ("error" in graphValidation) return c.json({ error: "图谱模型配置无效：" + graphValidation.error }, 400);
    }

    const form = await c.req.parseBody();
    const file = form["file"];
    if (!(file instanceof File)) return c.json({ error: "未找到上传文件（字段名 file）" }, 400);
    const nameValidation = validateFileName(file.name);
    if ("error" in nameValidation) return c.json({ error: nameValidation.error }, 400);
    const fileName = nameValidation.value;
    if (file.size > MAX_MB * 1024 * 1024) {
      return c.json({ error: "文件超过 " + MAX_MB + "MB 限制" }, 413);
    }
    const type = fileTypeOf(fileName);
    if (!type) return c.json({ error: "仅支持 PDF / DOCX / TXT（.doc 请先另存为 .docx）" }, 400);

    const docId = randomUUID();
    const buf = await file.arrayBuffer();
    // 先落库（processing），文档库立即可见，处理失败再回滚为 failed
    await storage.createDocument({ id: docId, name: fileName, type, size: file.size });

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { /* 客户端断开，忽略 */ }
        };
        const cleanupFail = async (msg: string) => {
          try {
            await storage.updateDocument(docId, { status: "failed", error: msg });
            await storage.deleteChunksByDoc(docId);
            await storage.deleteGraphByDoc(docId).catch(() => {});
            await storage.deleteFile("docs/" + docId + "/" + fileName).catch(() => {});
          } catch { /* 忽略清理错误 */ }
          emit({ type: "error", message: msg, id: docId });
        };
        try {
          // 1. 解析
          emit({ type: "stage", stage: "parse", pct: 6, label: "解析文档…" });
          const parsed = await parseFile(buf, type);
          // TXT/DOCX 二次分块（按段落）；PDF 已按页分块
          let chunks = parsed.chunks;
          if (type !== "pdf") {
            chunks = chunkText(parsed.chunks.map((c) => c.text).join("\n\n"));
          }
          if (chunks.length === 0) throw new Error("未能从文档中提取到有效文本");
          emit({ type: "stage", stage: "chunk", pct: 12, label: `分块完成：${chunks.length} 块` });

          // 2. 批量 embedding（每批 32，逐批上报真实进度）
          const totalBatches = Math.max(1, Math.ceil(chunks.length / 32));
          const vectors: number[][] = [];
          for (let i = 0; i < chunks.length; i += 32) {
            const batch = chunks.slice(i, i + 32).map((c) => c.text);
            vectors.push(...(await embedTexts(embedCfg, batch)));
            const doneBatches = Math.min(totalBatches, Math.ceil((i + batch.length) / 32));
            emit({
              type: "stage", stage: "embed",
              pct: Math.min(84, 14 + Math.round(66 * ((i + batch.length) / chunks.length))),
              done: doneBatches,
              total: totalBatches,
              label: `向量化 ${doneBatches}/${totalBatches} 批`,
            });
          }
          const rows = chunks.map((c, i) => ({
            id: randomUUID(),
            docId,
            seq: i,
            text: c.text,
            page: c.page ?? null,
            tokens: Math.ceil(c.text.length / 3),
            vector: JSON.stringify(vectors[i] ?? []),
          }));
          // 解析/向量化期间文档可能已被删除：放弃提交，避免留下孤儿块与原文件
          if (!(await storage.getDocument(docId))) {
            await storage.deleteFile("docs/" + docId + "/" + fileName).catch(() => {});
            emit({ type: "error", message: "文档已被删除", id: docId });
            return;
          }
          emit({ type: "stage", stage: "finalize", pct: 86, label: "写入向量索引…" });
          await storage.insertChunks(rows);

          // 3. 图谱抽取（失败仅标记 graphStatus=failed，不影响向量索引；逐批上报）
          let graph: GraphOutcome = NONE;
          if (opts.graph && profile) {
            try {
              emit({ type: "stage", stage: "graph", pct: 90, label: "图谱抽取准备…" });
              const graphData = await buildDocGraph(
                profile,
                chunks.map((ch, i) => ({ seq: i, text: ch.text })),
                (done, total) => emit({
                  type: "stage", stage: "graph",
                  pct: Math.min(97, 90 + Math.round(7 * (done / total))),
                  done, total,
                  label: `图谱抽取 ${done}/${total} 批`,
                }),
              );
              await storage.replaceDocGraph(docId, graphData.entities, graphData.relations);
              graph = { status: "ready", error: null, entityCount: graphData.entities.length };
            } catch (e) {
              graph = { status: "failed", error: e instanceof Error ? e.message : "图谱抽取失败", entityCount: 0 };
              await storage.deleteGraphByDoc(docId).catch(() => {});
            }
          } else {
            await storage.deleteGraphByDoc(docId).catch(() => {});
          }
          await storage.updateDocument(docId, {
            status: "ready",
            chunkCount: rows.length,
            error: null,
            embeddingProfile: embeddingProfileOf(embedCfg, vectors[0]?.length),
          });
          await storage.updateGraphState(docId, { graphStatus: graph.status, graphError: graph.error ?? null, entityCount: graph.entityCount });
          // 留存原文件
          await storage.putFile("docs/" + docId + "/" + fileName, buf, file.type || "application/octet-stream");
          emit({ type: "done", id: docId, name: fileName, chunks: rows.length, pages: parsed.pageCount ?? null, graphStatus: graph.status, entityCount: graph.entityCount });
        } catch (e) {
          const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "解析失败";
          await cleanupFail(msg);
        } finally {
          try { controller.close(); } catch { /* ignore */ }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // 列表
  app.get("/", async (c) => {
    const docs = await storage.listDocuments();
    return c.json(docs.map((d) => ({
      id: d.id, name: d.name, type: d.type, size: d.size,
      status: d.status, chunkCount: d.chunkCount, error: d.error, createdAt: new Date(d.createdAt).toISOString(),
      graphStatus: d.graphStatus ?? "none", entityCount: d.entityCount ?? 0, graphError: d.graphError ?? null,
      embeddingProfile: d.embeddingProfile ?? null,
    })));
  });

  // 批量删除：删除请求体 ids 中的所选文档（真删除，级联清向量索引 + 图谱 + 原文件）
  // 注意：静态路径 "/"、"/all" 必须注册在 "/:id" 之前，否则会被参数路由吞掉
  app.delete("/", async (c) => {
    const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids)
      ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))].slice(0, 500)
      : [];
    if (ids.length === 0) return c.json({ error: "未指定要删除的文档（ids 不能为空）" }, 400);
    let deleted = 0;
    for (const id of ids) {
      if (await purgeDocument(storage, id)) deleted++;
    }
    return c.json({ ok: true, deleted });
  });

  // 一键删除：清空整个文档库（真删除全部本地/对象存储原始文件与索引）
  app.delete("/all", async (c) => {
    const docs = await storage.listDocuments();
    let deleted = 0;
    for (const d of docs) {
      if (await purgeDocument(storage, d.id)) deleted++;
    }
    return c.json({ ok: true, deleted });
  });

  // 删除单个（幂等；级联清理向量索引 + 图谱 + 原文件）
  app.delete("/:id", async (c) => {
    await purgeDocument(storage, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 重新索引：重建分块/向量/图谱
  app.post("/:id/reindex", async (c) => {
    const id = c.req.param("id");
    const doc = await storage.getDocument(id);
    if (!doc) return c.json({ error: "文档不存在" }, 404);
    const embedCfg: EmbedConfig = embedCfgOf(c);
    const embedValidation = validateEmbedConfig(embedCfg);
    if ("error" in embedValidation) return c.json({ error: "Embedding 配置无效：" + embedValidation.error }, 400);
    const chatCfg = chatCfgOf(c);
    const indexCfg = indexCfgOf(c);
    const profile = graphProfileOf(chatCfg, indexCfg);
    const opts = optionsOf(c, { rewrite: true, graph: true, rerank: false });
    if (opts.graph && profile) {
      const graphValidation = validateOptionalModelConfig(profile);
      if ("error" in graphValidation) return c.json({ error: "图谱模型配置无效：" + graphValidation.error }, 400);
    }
    const file = await storage.getFile("docs/" + id + "/" + doc.name);
    if (!file) return c.json({ error: "原始文件不存在，无法重新索引" }, 404);
    // 幂等互斥
    const locked = await storage.beginProcessing(id);
    if (!locked) {
      return c.json({ error: "该文档正在处理中，请勿重复操作（若长时间卡在“索引中”，请删除后重新上传）" }, 409);
    }
    try {
      const parsed = await parseFile(file.data, doc.type);
      const chunks = doc.type !== "pdf" ? chunkText(parsed.chunks.map((c) => c.text).join("\n\n")) : parsed.chunks;
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += 32) {
        const batch = chunks.slice(i, i + 32).map((c) => c.text);
        vectors.push(...(await embedTexts(embedCfg, batch)));
      }
      if (!(await storage.getDocument(id))) {
        return c.json({ error: "文档已被删除", id }, 404);
      }
      await storage.deleteChunksByDoc(id);
      const rows = chunks.map((c, i) => ({
        id: randomUUID(), docId: id, seq: i, text: c.text, page: c.page ?? null,
        tokens: Math.ceil(c.text.length / 3), vector: JSON.stringify(vectors[i] ?? []),
      }));
      await storage.insertChunks(rows);
      let graph: GraphOutcome = NONE;
      if (opts.graph && profile) {
        try {
          const graphData = await buildDocGraph(profile, chunks.map((ch, i) => ({ seq: i, text: ch.text })));
          await storage.replaceDocGraph(id, graphData.entities, graphData.relations);
          graph = { status: "ready", error: null, entityCount: graphData.entities.length };
        } catch (e) {
          graph = { status: "failed", error: e instanceof Error ? e.message : "图谱抽取失败", entityCount: 0 };
        }
      } else {
        await storage.deleteGraphByDoc(id).catch(() => {});
      }
      await storage.updateDocument(id, {
        status: "ready",
        chunkCount: rows.length,
        error: null,
        embeddingProfile: embeddingProfileOf(embedCfg, vectors[0]?.length),
      });
      await storage.updateGraphState(id, { graphStatus: graph.status, graphError: graph.error ?? null, entityCount: graph.entityCount });
      return c.json({ ok: true, chunks: rows.length, graphStatus: graph.status, entityCount: graph.entityCount });
    } catch (e) {
      const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "重新索引失败";
      await storage.updateDocument(id, { status: "failed", error: msg });
      await storage.deleteGraphByDoc(id).catch(() => {});
      return c.json({ error: msg }, 422);
    }
  });

  // 单独补建/重建图谱（向量索引已就绪的文档）
  app.post("/:id/graph", async (c) => {
    const id = c.req.param("id");
    const doc = await storage.getDocument(id);
    if (!doc) return c.json({ error: "文档不存在" }, 404);
    if (doc.status !== "ready") {
      return c.json({ error: "仅“就绪”状态的文档可补建图谱（先完成上传/重索引）" }, 409);
    }
    const chatCfg = chatCfgOf(c);
    const indexCfg = indexCfgOf(c);
    const profile = graphProfileOf(chatCfg, indexCfg);
    if (!profile) {
      return c.json({ error: "补建图谱需要对话模型或索引模型配置（见设置页）" }, 400);
    }
    const graphValidation = validateOptionalModelConfig(profile);
    if ("error" in graphValidation) return c.json({ error: "图谱模型配置无效：" + graphValidation.error }, 400);
    const locked = await storage.beginProcessing(id);
    if (!locked) return c.json({ error: "文档正在处理中，请稍后再试" }, 409);
    try {
      const rows = await storage.listChunksByDoc(id);
      if (rows.length === 0) throw new Error("文档还没有分块（请先上传/重索引）");
      const graphData = await buildDocGraph(profile, rows.map((r) => ({ seq: r.seq, text: r.text })));
      await storage.replaceDocGraph(id, graphData.entities, graphData.relations);
      await storage.updateDocument(id, { status: "ready", error: null });
      await storage.updateGraphState(id, { graphStatus: "ready", graphError: null, entityCount: graphData.entities.length });
      return c.json({ ok: true, entities: graphData.entities.length, relations: graphData.relations.length });
    } catch (e) {
      const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "图谱抽取失败";
      await storage.updateDocument(id, { status: "ready", error: null });
      await storage.updateGraphState(id, { graphStatus: "failed", graphError: msg, entityCount: 0 });
      return c.json({ error: msg }, 422);
    }
  });

  // 下载/预览原文件
  app.get("/:id/file", async (c) => {
    const id = c.req.param("id");
    const doc = await storage.getDocument(id);
    if (!doc) return c.json({ error: "文档不存在" }, 404);
    const file = await storage.getFile("docs/" + id + "/" + doc.name);
    if (!file) return c.json({ error: "文件不存在" }, 404);
    const inline = doc.type === "pdf" || doc.type === "txt";
    return new Response(file.data, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(doc.name),
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  // 提取文本（供前端查看/高亮）
  app.get("/:id/text", async (c) => {
    const id = c.req.param("id");
    const rows = await storage.listChunksByDoc(id);
    const full = rows.map((r) => (r.page ? "[第 " + r.page + " 页]\n" : "") + r.text).join("\n\n");
    return c.json({ text: full, chunks: rows.map((r) => ({ id: r.id, seq: r.seq, text: r.text, page: r.page })) });
  });

  return app;
}

// 供 chat 路由引用（避免循环依赖）
export const zDocId = z.string().uuid();
