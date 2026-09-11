import { Hono } from "hono";
import { z } from "zod";
import type { Storage } from "../storage/types";
import type { EmbedConfig } from "../../shared/types";
import { AiError } from "../services/ai";
import { buildDocGraph } from "../services/graph";
import { embedCfgOf, chatCfgOf, indexCfgOf, optionsOf, graphProfileOf } from "../services/reqCfg";
import { validateEmbedConfig, validateFileName, validateOptionalModelConfig } from "../services/requestValidation";
import { processDocument, type ProcessDocumentResult, type DocType } from "../services/documentProcessor";
import { detachedScheduler, type TaskScheduler } from "../services/taskScheduler";
import type { VectorIndex } from "../services/vectorIndex";
import { randomUUID } from "node:crypto";

const MAX_MB = Number(process.env.MAX_UPLOAD_MB ?? 20);

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
async function purgeDocument(storage: Storage, id: string, vectorIndex: VectorIndex | null = null): Promise<boolean> {
  const doc = await storage.getDocument(id);
  if (!doc) return false;
  // 先按分块 ID 清掉远程向量（失败不影响本地删除）
  if (vectorIndex) {
    const rows = await storage.listChunksByDoc(id).catch(() => []);
    if (rows.length > 0) {
      await vectorIndex.remove(rows.map((row) => row.id)).catch((error) =>
        console.warn("[documents] 清理远程向量失败:", error instanceof Error ? error.message : error));
    }
  }
  await storage.deleteChunksByDoc(id);
  await storage.deleteGraphByDoc(id);
  await storage.deleteDocument(id);
  await storage.deleteFile("docs/" + id + "/" + doc.name).catch(() => {});
  return true;
}

/** 极简 deferred：把调度器中的处理结果回传给流式响应。 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** 创建一个可控的 Promise。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function documentsRoutes(storage: Storage, scheduler: TaskScheduler = detachedScheduler, vectorIndex: VectorIndex | null = null) {
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
    // 先落库（processing），文档库立即可见；处理失败由管线统一标记为 failed
    await storage.createDocument({ id: docId, name: fileName, type, size: file.size });

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { /* 客户端断开，忽略 */ }
        };
        const deferred = createDeferred<ProcessDocumentResult>();
        // 交给调度器托管：Node 走进程内队列，Worker 走 waitUntil；客户端断开后处理仍会继续，进度持续落库。
        scheduler.run(async () => {
          try {
            deferred.resolve(await processDocument({
              storage,
              docId,
              fileName,
              type,
              buffer: buf,
              contentType: file.type || "application/octet-stream",
              embedCfg,
              graph: { enabled: opts.graph, profile },
              vectorIndex,
              onProgress: (progress) => emit({ type: "stage", ...progress }),
            }));
          } catch (error) {
            deferred.reject(error);
          }
        });
        try {
          const result = await deferred.promise;
          emit({
            type: "done", id: docId, name: fileName,
            chunks: result.chunks, pages: result.pages,
            graphStatus: result.graphStatus, entityCount: result.entityCount,
          });
        } catch (error) {
          const message = error instanceof AiError ? error.message : error instanceof Error ? error.message : "解析失败";
          emit({ type: "error", message, id: docId });
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
      progressStage: d.progressStage ?? null,
      progressPct: d.progressPct ?? 0,
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
      if (await purgeDocument(storage, id, vectorIndex)) deleted++;
    }
    return c.json({ ok: true, deleted });
  });

  // 一键删除：清空整个文档库（真删除全部本地/对象存储原始文件与索引）
  app.delete("/all", async (c) => {
    const docs = await storage.listDocuments();
    let deleted = 0;
    for (const d of docs) {
      if (await purgeDocument(storage, d.id, vectorIndex)) deleted++;
    }
    return c.json({ ok: true, deleted });
  });

  // 删除单个（幂等；级联清理向量索引 + 图谱 + 原文件）
  app.delete("/:id", async (c) => {
    await purgeDocument(storage, c.req.param("id"));
    return c.json({ ok: true });
  });

  // 重新索引：重建分块/向量/图谱
  // 处理任务交由调度器托管：即使发起方中途断开，重索引也会继续执行到完成或失败。
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
    const deferred = createDeferred<ProcessDocumentResult>();
    scheduler.run(async () => {
      try {
        deferred.resolve(await processDocument({
          storage,
          docId: id,
          fileName: doc.name,
          type: doc.type as DocType,
          buffer: file.data,
          contentType: file.contentType,
          embedCfg,
          graph: { enabled: opts.graph, profile },
          replaceExisting: true,
          vectorIndex,
        }));
      } catch (error) {
        deferred.reject(error);
      }
    });
    try {
      const result = await deferred.promise;
      return c.json({ ok: true, chunks: result.chunks, graphStatus: result.graphStatus, entityCount: result.entityCount });
    } catch (error) {
      const message = error instanceof AiError ? error.message : error instanceof Error ? error.message : "重新索引失败";
      return c.json({ error: message }, 422);
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
    // 交由调度器托管：即使发起方中途断开，图谱抽取也会继续完成
    const deferred = createDeferred<{ entities: number; relations: number }>();
    scheduler.run(async () => {
      try {
        const rows = await storage.listChunksByDoc(id);
        if (rows.length === 0) throw new Error("文档还没有分块（请先上传/重索引）");
        const graphData = await buildDocGraph(profile, rows.map((r) => ({ seq: r.seq, text: r.text })));
        await storage.replaceDocGraph(id, graphData.entities, graphData.relations);
        await storage.updateDocument(id, { status: "ready", error: null, progressStage: null, progressPct: 100 });
        await storage.updateGraphState(id, { graphStatus: "ready", graphError: null, entityCount: graphData.entities.length });
        deferred.resolve({ entities: graphData.entities.length, relations: graphData.relations.length });
      } catch (error) {
        deferred.reject(error);
      }
    });
    try {
      const result = await deferred.promise;
      return c.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof AiError ? error.message : error instanceof Error ? error.message : "图谱抽取失败";
      await storage.updateDocument(id, { status: "ready", error: null });
      await storage.updateGraphState(id, { graphStatus: "failed", graphError: message, entityCount: 0 });
      return c.json({ error: message }, 422);
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
