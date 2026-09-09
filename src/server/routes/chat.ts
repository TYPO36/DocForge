import { Hono } from "hono";
import type { Storage } from "../storage/types";
import type { ChatRequest } from "../../shared/types";
import { chatStream, AiError } from "../services/ai";
import { toCitations } from "../services/retrieve";
import { runRag } from "../services/rag";
import { chatCfgOf, embedCfgOf, rerankCfgOf, optionsOf } from "../services/reqCfg";
import { buildSystemPrompt, buildMessages } from "../services/prompts";

function sseEncode(event: string, data: unknown): string {
  return "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
}

export function chatRoutes(storage: Storage) {
  const app = new Hono<{ Variables: { storage: Storage } }>();

  app.post("/", async (c) => {
    const chatCfg = chatCfgOf(c);
    const embedCfg = embedCfgOf(c);
    if (!chatCfg.baseUrl || !chatCfg.apiKey || !chatCfg.model) {
      return c.json({ error: "缺少 Chat 模型配置（请在设置页填写）" }, 400);
    }
    if (!embedCfg.baseUrl || !embedCfg.apiKey || !embedCfg.model) {
      return c.json({ error: "缺少 Embedding 配置（请在设置页填写）" }, 400);
    }
    const rerankCfg = rerankCfgOf(c);
    // 设置页默认：多查询改写开 / 图谱检索开 / rerank 关（关闭即回到 v1 纯向量行为）
    const opts = optionsOf(c, { rewrite: true, graph: true, rerank: false });

    const body = (await c.req.json().catch(() => null)) as ChatRequest | null;
    if (!body || !body.question?.trim()) return c.json({ error: "问题不能为空" }, 400);
    const question = body.question.trim();
    const topK = Math.min(Math.max(body.topK ?? 5, 1), 12);
    if (body.temperature !== undefined) chatCfg.temperature = body.temperature;
    if (body.maxTokens !== undefined) chatCfg.maxTokens = body.maxTokens;
    // 请求体 options 可覆盖请求头默认（高级用法）
    if (body.options?.rewrite !== undefined) opts.rewrite = body.options.rewrite;
    if (body.options?.graph !== undefined) opts.graph = body.options.graph;
    if (body.options?.rerank !== undefined) opts.rerank = body.options.rerank;

    try {
      // RAG v2：改写 → 混合检索（向量+BM25+RRF）→ 图谱通道 → 父子窗口 →（可选 rerank）
      const result = await runRag(storage, question, chatCfg, embedCfg, rerankCfg, opts, topK);
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
