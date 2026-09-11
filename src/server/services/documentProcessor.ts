/**
 * @author JTP
 * @date 2026-09-11
 * @description 文档处理管线：解析 → 分块 → 向量化 → 图谱抽取 → 落库。
 *
 * 上传与重索引共用同一条管线，避免两份实现漂移；处理进度既通过回调实时外发（供流式响应），
 * 也落到 documents 表，使前端刷新或断线后仍能看到真实阶段。
 */
import type { Storage } from "../storage/types";
import type { ChatConfig, EmbedConfig, IndexConfig } from "../../shared/types";
import { parseFile } from "./parser";
import { chunkText } from "./chunker";
import { embedTexts, AiError } from "./ai";
import type { VectorIndex } from "./vectorIndex";
import { buildDocGraph } from "./graph";
import { embeddingProfileKeyOf, embeddingProfileOf } from "../../shared/embeddingProfile";
import { encodeVector } from "./vectorCodec";
import { randomUUID } from "node:crypto";

/** 支持的文档类型。 */
export type DocType = "pdf" | "docx" | "txt";
/** 图谱抽取状态。 */
export type GraphOutcomeStatus = "none" | "building" | "ready" | "failed";
/** 每批送入 Embedding 接口的分块数。 */
const EMBED_BATCH_SIZE = 32;
/** 图谱阶段起始百分比。 */
const GRAPH_PCT_START = 90;
/** 图谱阶段占用的百分比区间。 */
const GRAPH_PCT_SPAN = 7;

/** 处理进度事件：与前端进度条及持久化进度字段一一对应。 */
export interface ProcessProgress {
  stage: "parse" | "chunk" | "embed" | "finalize" | "graph";
  pct: number;
  label: string;
  done?: number;
  total?: number;
}

/** 处理管线入参。 */
export interface ProcessDocumentInput {
  storage: Storage;
  /** 目标文档 ID（调用方需保证该文档记录已存在）。 */
  docId: string;
  /** 原始文件名，用于原文件留存路径。 */
  fileName: string;
  type: DocType;
  buffer: ArrayBuffer;
  /** 原文件 MIME 类型。 */
  contentType: string;
  embedCfg: EmbedConfig;
  graph: {
    enabled: boolean;
    /** 图谱抽取使用的模型配置；为空表示未配置，跳过图谱。 */
    profile: IndexConfig | ChatConfig | null;
  };
  /** 写入前是否清空该文档已有分块（重索引场景），默认 false。 */
  replaceExisting?: boolean;
  /** 可选的远程向量索引（Cloudflare Vectorize）；为空时只写本地分块向量。 */
  vectorIndex?: VectorIndex | null;
  /** 进度回调；回调抛出的异常不影响主管线。 */
  onProgress?: (progress: ProcessProgress) => void;
}

/** 处理结果。 */
export interface ProcessDocumentResult {
  chunks: number;
  pages: number | null;
  graphStatus: GraphOutcomeStatus;
  entityCount: number;
}

/**
 * 执行一次完整的文档处理。
 *
 * 失败时会把文档标记为 failed、清理半成品分块/图谱/原文件，并原样抛出错误供调用方转述。
 *
 * @param input 处理入参。
 * @returns 分块数、页数、图谱状态与实体数。
 * @throws {AiError} 上游模型接口返回错误时抛出，携带可直接展示的中文信息。
 * @throws {Error} 解析失败、文档被删除或写入失败时抛出。
 */
export async function processDocument(input: ProcessDocumentInput): Promise<ProcessDocumentResult> {
  const { storage, docId, fileName, type, buffer, embedCfg, graph } = input;
  let progressChain: Promise<void> = Promise.resolve();
  const report = (progress: ProcessProgress): void => {
    try {
      input.onProgress?.(progress);
    } catch (error) {
      console.warn("[processor] 进度回调异常（忽略）:", error instanceof Error ? error.message : error);
    }
    // 进度写库串行执行：既不阻塞主流程，也避免并发写入导致阶段回退。
    progressChain = progressChain
      .then(() => storage.updateDocument(docId, { progressStage: progress.stage, progressPct: progress.pct }))
      .catch(() => {});
  };

  try {
    report({ stage: "parse", pct: 6, label: "解析文档…" });
    const parsed = await parseFile(buffer, type);
    // TXT/DOCX 二次分块（按段落）；PDF 已按页分块
    const chunks = type === "pdf"
      ? parsed.chunks
      : chunkText(parsed.chunks.map((chunk) => chunk.text).join("\n\n"));
    if (chunks.length === 0) throw new Error("未能从文档中提取到有效文本");
    report({ stage: "chunk", pct: 12, label: `分块完成：${chunks.length} 块` });

    const totalBatches = Math.max(1, Math.ceil(chunks.length / EMBED_BATCH_SIZE));
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batchTexts = chunks.slice(i, i + EMBED_BATCH_SIZE).map((chunk) => chunk.text);
      vectors.push(...(await embedTexts(embedCfg, batchTexts)));
      const doneBatches = Math.min(totalBatches, Math.ceil((i + batchTexts.length) / EMBED_BATCH_SIZE));
      report({
        stage: "embed",
        pct: Math.min(84, 14 + Math.round(66 * ((i + batchTexts.length) / chunks.length))),
        done: doneBatches,
        total: totalBatches,
        label: `向量化 ${doneBatches}/${totalBatches} 批`,
      });
    }

    const rows = chunks.map((chunk, index) => ({
      id: randomUUID(),
      docId,
      seq: index,
      text: chunk.text,
      page: chunk.page ?? null,
      tokens: Math.ceil(chunk.text.length / 3),
      vector: encodeVector(vectors[index] ?? []),
    }));

    // 解析/向量化期间文档可能已被删除：放弃提交，避免留下孤儿分块与原文件
    if (!(await storage.getDocument(docId))) {
      await storage.deleteFile("docs/" + docId + "/" + fileName).catch(() => {});
      throw new Error("文档已被删除");
    }

    report({ stage: "finalize", pct: 86, label: "写入向量索引…" });
    // 重索引：向量已就绪后再替换旧分块，尽量缩短"无可用索引"的窗口
    if (input.replaceExisting) {
      const previousRows = await storage.listChunksByDoc(docId);
      await storage.deleteChunksByDoc(docId);
      if (input.vectorIndex && previousRows.length > 0) {
        await input.vectorIndex.remove(previousRows.map((row) => row.id)).catch((error) =>
          console.warn("[processor] 清理旧向量失败（不影响本地索引）:", error instanceof Error ? error.message : error));
      }
    }
    await storage.insertChunks(rows);

    // 可选：把向量同步到远程索引；失败不阻塞本地索引，检索会自动回退本地计算
    if (input.vectorIndex) {
      const namespace = embeddingProfileKeyOf(embedCfg, vectors[0]?.length);
      if (namespace) {
        try {
          await input.vectorIndex.upsert(
            rows.map((row, index) => ({ id: row.id, docId, seq: row.seq, vector: vectors[index] ?? [] })),
            namespace,
          );
        } catch (error) {
          console.warn("[processor] Vectorize 写入失败，检索将回退本地向量计算:", error instanceof Error ? error.message : error);
        }
      }
    }

    // 图谱抽取失败只标记状态，不影响向量检索可用性
    let graphStatus: GraphOutcomeStatus = "none";
    let graphError: string | null = null;
    let entityCount = 0;
    if (graph.enabled && graph.profile) {
      try {
        report({ stage: "graph", pct: GRAPH_PCT_START, label: "图谱抽取准备…" });
        const graphData = await buildDocGraph(
          graph.profile,
          chunks.map((chunk, index) => ({ seq: index, text: chunk.text })),
          (done, total) => report({
            stage: "graph",
            pct: Math.min(97, GRAPH_PCT_START + Math.round(GRAPH_PCT_SPAN * (done / total))),
            done,
            total,
            label: `图谱抽取 ${done}/${total} 批`,
          }),
        );
        await storage.replaceDocGraph(docId, graphData.entities, graphData.relations);
        graphStatus = "ready";
        entityCount = graphData.entities.length;
      } catch (error) {
        graphStatus = "failed";
        graphError = error instanceof Error ? error.message : "图谱抽取失败";
        await storage.deleteGraphByDoc(docId).catch(() => {});
      }
    } else {
      await storage.deleteGraphByDoc(docId).catch(() => {});
    }

    await storage.putFile("docs/" + docId + "/" + fileName, buffer, input.contentType);
    await storage.updateDocument(docId, {
      status: "ready",
      chunkCount: rows.length,
      error: null,
      embeddingProfile: embeddingProfileOf(embedCfg, vectors[0]?.length),
      progressStage: null,
      progressPct: 100,
    });
    await storage.updateGraphState(docId, { graphStatus, graphError, entityCount });
    await progressChain;
    return { chunks: rows.length, pages: parsed.pageCount ?? null, graphStatus, entityCount };
  } catch (error) {
    const message = error instanceof AiError ? error.message : error instanceof Error ? error.message : "解析失败";
    await failDocument(storage, docId, fileName, message);
    throw error;
  }
}

/**
 * 失败收尾：标记文档失败并清理半成品，保证可重试且不残留孤立数据。
 *
 * 清理过程本身出错只记录日志，不覆盖原始失败原因。
 */
async function failDocument(storage: Storage, docId: string, fileName: string, message: string): Promise<void> {
  try {
    await storage.updateDocument(docId, { status: "failed", error: message, progressStage: null, progressPct: 0 });
    await storage.deleteChunksByDoc(docId);
    await storage.deleteGraphByDoc(docId).catch(() => {});
    await storage.deleteFile("docs/" + docId + "/" + fileName).catch(() => {});
  } catch (error) {
    console.error("[processor] 失败清理未完成:", error instanceof Error ? error.message : error);
  }
}
