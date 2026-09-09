import type { ChatConfig, EmbedConfig, RerankConfig } from "../../shared/types";

export class AiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function normBase(url: string): string {
  return url.replace(/\/$/, "");
}

async function requestJson(baseUrl: string, apiKey: string, path: string, body: unknown, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(normBase(baseUrl) + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new AiError(res.status + " " + res.statusText + (t ? " — " + t.slice(0, 300) : ""), res.status);
    }
    return (await res.json()) as any;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new AiError("请求超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// —— Embedding：由免费开源 embedding 模型承担（bge-m3 硅基流动免费额度 / Ollama 本地），不产生 LLM token 费用 ——
export async function embedTexts(cfg: EmbedConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const body: Record<string, unknown> = { model: cfg.model, input: texts };
  if (cfg.dimension > 0 && /qwen3-embedding/i.test(cfg.model)) {
    body.dimensions = cfg.dimension;
  }
  const json = await requestJson(cfg.baseUrl, cfg.apiKey, "/embeddings", body, 120000);
  const data = json?.data;
  if (!Array.isArray(data)) throw new AiError("Embedding 响应格式异常（无 data 数组）");
  const vecs: number[][] = [];
  for (const item of data) {
    if (!Array.isArray(item?.embedding)) throw new AiError("Embedding 响应缺少 embedding 字段");
    vecs.push(item.embedding as number[]);
  }
  return vecs;
}

export async function embedText(cfg: EmbedConfig, text: string): Promise<number[]> {
  const [v] = await embedTexts(cfg, [text]);
  return v;
}

/**
 * 检索模型大多要求只在查询（query）侧加指令前缀，入库的文档文本不加。
 */
export function retrievalPrefix(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("qwen3-embedding")) {
    return "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";
  }
  if (m.includes("bge")) {
    return "为这个句子生成表示以用于检索相关文章：";
  }
  return "";
}

export async function embedQuery(cfg: EmbedConfig, text: string): Promise<number[]> {
  const [v] = await embedTexts(cfg, [retrievalPrefix(cfg.model) + text]);
  return v;
}

export async function testEmbed(cfg: EmbedConfig): Promise<{ latencyMs: number; dimension: number }> {
  const t0 = Date.now();
  const [v] = await embedTexts(cfg, ["ping"]);
  return { latencyMs: Date.now() - t0, dimension: v.length };
}

export interface ChatStreamResult {
  ok: boolean;
  status?: number;
}

// 流式调用 chat completions（最终回答，可能付费的对话模型）
export async function chatStream(cfg: ChatConfig, messages: { role: string; content: string }[], onDelta: (d: string) => void): Promise<ChatStreamResult> {
  const ctrl = new AbortController();
  const res = await fetch(normBase(cfg.baseUrl) + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature ?? 0.7,
      max_tokens: cfg.maxTokens ?? 4096,
    }),
    signal: ctrl.signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new AiError(res.status + " " + res.statusText + (t ? " — " + t.slice(0, 300) : ""), res.status);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body || !ct.includes("text/event-stream")) {
    const json: any = await res.json().catch(() => null);
    const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? "";
    onDelta(String(content));
    return { ok: true };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json: any = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? "";
          if (delta) onDelta(String(delta));
        } catch { /* ignore */ }
      }
    }
  }
  return { ok: true };
}

// —— RAG v2 · 工具性非流式调用（多查询改写 / 图谱抽取共用） ——
// 语义标注：改写 = 每次提问多 1 次小调用（约 300~500 token）；图谱抽取 = 文档一次性多批（大头，见 IndexConfig 说明）。
export async function chatJson(
  cfg: { baseUrl: string; apiKey: string; model: string },
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 500,
    stream: false,
  };
  const json = await requestJson(cfg.baseUrl, cfg.apiKey, "/chat/completions", body, opts.timeoutMs ?? 90000);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new AiError("模型响应缺少内容字段");
  return content;
}

/** 多查询改写；失败返回空数组 → 调用方回退单原问（优雅降级） */
export async function rewriteQueries(cfg: ChatConfig, question: string): Promise<string[]> {
  const sys =
    "你是检索查询改写助手。请把用户的问题改写为恰好 3 个不同的检索查询，覆盖：1) 原问题；2) 更泛化的表述；3) 使用同义词/别名/补充背景的表述。只输出 JSON 字符串数组，不要解释，不要 Markdown。";
  const content = await chatJson(
    { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    [
      { role: "system", content: sys },
      { role: "user", content: question },
    ],
    { maxTokens: 300, temperature: 0.9, timeoutMs: 45000 },
  );
  const arr = parseStringArray(content);
  if (arr.length < 2) return [];
  return arr.slice(0, 3).filter((s) => s.trim().length >= 4).map((s) => s.trim());
}

function parseStringArray(raw: string): string[] {
  const t = raw.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  let candidate = start >= 0 && end > start ? t.slice(start, end + 1) : t;
  // 去掉可能的 Markdown 围栏残留（不依赖反引号书写）
  candidate = candidate.split("\n").map((s) => s.replace(/^(json|JSON)?\s*/i, "").trim()).join("\n");
  try {
    const v = JSON.parse(candidate);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch { /* fallthrough */ }
  return raw
    .split(/[\n\r]+|[，,；;]/)
    .map((s) => s.replace(/^[\s\d.、\-"'']+/, "").trim())
    .filter((s) => s.length >= 4);
}

/**
 * 二次重排（rerank）：交叉编码器对 query×document 打分重排。
 * 语义标注：推荐免费开源模型 bge-reranker-v2-m3（硅基流动免费额度，或任意实现
 * POST {base}/rerank {model, query, documents} 的兼容服务）。失败抛错，调用方回退融合排序。
 */
export async function rerank(
  cfg: RerankConfig,
  query: string,
  documents: string[],
): Promise<{ index: number; score: number }[]> {
  if (!documents.length) return [];
  const json = await requestJson(cfg.baseUrl, cfg.apiKey, "/rerank", {
    model: cfg.model,
    query,
    documents,
  }, 60000);
  const results = json?.results;
  if (!Array.isArray(results)) throw new AiError("Rerank 响应格式异常（无 results 数组）");
  return results
    .map((r: any) => ({ index: Number(r?.index), score: Number(r?.relevance_score ?? r?.score ?? 0) }))
    .filter((r: { index: number; score: number }) => Number.isFinite(r.index) && Number.isFinite(r.score));
}

export async function testChat(cfg: ChatConfig): Promise<{ latencyMs: number }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(normBase(cfg.baseUrl) + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 5, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new AiError(res.status + " " + res.statusText + (t ? " — " + t.slice(0, 200) : ""), res.status);
    }
    await res.json();
    return { latencyMs: Date.now() - t0 };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new AiError("连接超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
