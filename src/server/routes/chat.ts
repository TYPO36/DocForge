import { Hono } from "hono";
import type { Storage } from "../storage/types";
import { chatStream, AiError } from "../services/ai";
import { toCitations } from "../services/retrieve";
import { runRag } from "../services/rag";
import { chatCfgOf, embedCfgOf, rerankCfgOf, optionsOf } from "../services/reqCfg";
import { buildSystemPrompt, buildMessages } from "../services/prompts";
import { parseChatRequest, validateChatConfig, validateEmbedConfig, validateOptionalModelConfig } from "../services/requestValidation";
import type { VectorIndex } from "../services/vectorIndex";

function sseEncode(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

export function chatRoutes(storage: Storage, vectorIndex: VectorIndex | null = null) {
  const app = new Hono<{ Variables: { storage: Storage } }>();

  app.post("/", async (c) => {
    const chatCfg = chatCfgOf(c);
    const embedCfg = embedCfgOf(c);
    const chatValidation = validateChatConfig(chatCfg);
    if ("error" in chatValidation) return c.json({ error: "Chat 配置无效：" + chatValidation.error }, 400);
    const embedValidation = validateEmbedConfig(embedCfg);
    if ("error" in embedValidation) return c.json({ error: "Embedding 配置无效：" + embedValidation.error }, 400);
    const rerankCfg = rerankCfgOf(c);
    // 设置页默认：多查询改写开 / 图谱检索开 / rerank 关（关闭即回到 v1 纯向量行为）
    const opts = optionsOf(c, { rewrite: true, graph: true, rerank: false });

    if (opts.rerank && rerankCfg.enabled) {
      const rerankValidation = validateOptionalModelConfig(rerankCfg, true);
      if ("error" in rerankValidation) return c.json({ error: "Rerank 配置无效：" + rerankValidation.error }, 400);
    }
    const requestValidation = parseChatRequest(await c.req.json().catch(() => null));
    if ("error" in requestValidation) return c.json({ error: requestValidation.error }, 400);
    const body = requestValidation.value;
    const question = body.question;
    const topK = body.topK ?? 5;
    if (body.temperature !== undefined) chatCfg.temperature = body.temperature;
    if (body.maxTokens !== undefined) chatCfg.maxTokens = body.maxTokens;
    // 请求体 options 可覆盖请求头默认（高级用法）
    if (body.options?.rewrite !== undefined) opts.rewrite = body.options.rewrite;
    if (body.options?.graph !== undefined) opts.graph = body.options.graph;
    if (body.options?.rerank !== undefined) opts.rerank = body.options.rerank;

    try {
      const startedAt = Date.now();
      // RAG v2：改写 → 混合检索（向量+BM25+RRF）→ 图谱通道 → 父子窗口 →（可选 rerank）
      const result = await runRag(storage, question, chatCfg, embedCfg, rerankCfg, opts, topK, vectorIndex);
      if (result.stats.compatibleDocuments === 0 && result.stats.incompatibleDocuments > 0) {
        return c.json({ error: "当前 Embedding 配置与已索引文档不一致，请在文档库逐个执行“重新索引”后再提问" }, 409);
      }
      console.info("[rag] retrieval", JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        compatibleDocuments: result.stats.compatibleDocuments,
        incompatibleDocuments: result.stats.incompatibleDocuments,
        scannedChunks: result.stats.scannedChunks,
        sources: result.sources.length,
        variants: result.stats.variants.length,
        graph: opts.graph,
        reranked: result.stats.reranked,
        vectorBackend: result.stats.vectorBackend,
      }));
      const citations = toCitations(result.sources);
      const docRows = await storage.listDocuments();
      const system = buildSystemPrompt(
        result.sources,
        docRows.map((d) => ({ name: d.name, type: d.type, status: d.status })),
        result.facts,
      );
      const messages = buildMessages(system, (body.history ?? []).map((h) => ({ role: h.role, content: h.content })), question);

      // SSE 流式返回
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(encoder.encode(sseEncode("citations", citations)));
            let full = "";
            await chatStream(chatCfg, messages, (delta) => {
              full += delta;
              controller.enqueue(encoder.encode(sseEncode("delta", { text: delta })));
            });
            controller.enqueue(encoder.encode(sseEncode("done", { content: full, citations })));
            controller.close();
          } catch (e) {
            const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "生成失败";
            try {
              controller.enqueue(encoder.encode(sseEncode("error", { message: msg })));
              controller.close();
            } catch { /* ignore */ }
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (e) {
      const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "处理失败";
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
