import type { AppConfig, ChatConfig, EmbedConfig, IndexConfig, RerankConfig, RagOptions } from "../../shared/types";

const KEY = "docforge:config:v1";

/**
 * 免费开源模型推荐（语义标注）
 * - Embedding：BAAI/bge-m3（MIT 开源；硅基流动免费额度 / Ollama 本地）
 * - Rerank：BAAI/bge-reranker-v2-m3（开源；硅基流动免费额度 / 兼容服务）
 * - 图谱抽取：默认复用对话模型（消耗其 Token），可单独配置为本机 Ollama（免费开源）
 */
export const EMBED_MODEL_RECOMMENDED = "BAAI/bge-m3";
export const RERANK_MODEL_RECOMMENDED = "BAAI/bge-reranker-v2-m3";
/** 硅基流动上付费的 Embedding 模型（自动回退免费模型） */
const PAID_EMBED_MODELS = ["Qwen/Qwen3-Embedding-8B", "Qwen/Qwen3-Embedding-4B", "Qwen/Qwen3-Embedding-0.6B"];

const DEFAULT_INDEX: IndexConfig = { baseUrl: "", apiKey: "", model: "" };
const DEFAULT_RERANK: RerankConfig = {
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "",
  model: RERANK_MODEL_RECOMMENDED,
  enabled: false,
};
const DEFAULT_OPTIONS: RagOptions = { rewrite: true, graph: true, rerank: false };

export const DEFAULT_CONFIG: AppConfig = {
  chat: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    temperature: 0.7,
    maxTokens: 4096,
    stream: true,
  },
  embed: {
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    model: EMBED_MODEL_RECOMMENDED,
    dimension: 1024,
  },
  index: DEFAULT_INDEX,
  rerank: DEFAULT_RERANK,
  options: DEFAULT_OPTIONS,
  topK: 5,
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppConfig>) : {};
    const base: AppConfig = {
      chat: { ...DEFAULT_CONFIG.chat, ...(parsed.chat ?? {}) },
      embed: { ...DEFAULT_CONFIG.embed, ...(parsed.embed ?? {}) },
      index: { ...DEFAULT_INDEX, ...(parsed.index ?? {}) },
      rerank: { ...DEFAULT_RERANK, ...(parsed.rerank ?? {}) },
      options: { ...DEFAULT_OPTIONS, ...(parsed.options ?? {}) },
      topK: parsed.topK ?? DEFAULT_CONFIG.topK,
    };
    return migrateConfig(base);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 配置迁移：硅基流动上的付费 Qwen3-Embedding 自动回退到免费的 bge-m3 */
function migrateConfig(cfg: AppConfig): AppConfig {
  const base = (cfg.embed.baseUrl || "").toLowerCase();
  if (base.includes("siliconflow") && PAID_EMBED_MODELS.includes(cfg.embed.model)) {
    return { ...cfg, embed: { ...cfg.embed, model: EMBED_MODEL_RECOMMENDED } };
  }
  return cfg;
}

export function saveConfig(cfg: AppConfig) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

/** 图谱抽取实际使用的模型：优先独立索引模型；未配置则回退对话模型（会消耗对话 Token，设置页已标注） */
export function graphIndexModel(cfg: AppConfig): { baseUrl: string; apiKey: string; model: string } | null {
  if (cfg.index.model && cfg.index.baseUrl && cfg.index.apiKey) return cfg.index;
  if (cfg.chat.model && cfg.chat.baseUrl && cfg.chat.apiKey) return { baseUrl: cfg.chat.baseUrl, apiKey: cfg.chat.apiKey, model: cfg.chat.model };
  return null;
}

export function chatHeaders(cfg: ChatConfig): Record<string, string> {
  return { "x-chat-base-url": cfg.baseUrl, "x-chat-api-key": cfg.apiKey, "x-chat-model": cfg.model };
}

export function embedHeaders(cfg: EmbedConfig): Record<string, string> {
  return { "x-embed-base-url": cfg.baseUrl, "x-embed-api-key": cfg.apiKey, "x-embed-model": cfg.model };
}

function indexHeaders(idx: IndexConfig): Record<string, string> {
  if (!idx.model || !idx.baseUrl || !idx.apiKey) return {};
  return { "x-index-base-url": idx.baseUrl, "x-index-api-key": idx.apiKey, "x-index-model": idx.model };
}

function rerankHeaders(rr: RerankConfig): Record<string, string> {
  if (!rr.enabled || !rr.model || !rr.baseUrl) return {};
  return { "x-rerank-base-url": rr.baseUrl, "x-rerank-api-key": rr.apiKey || "", "x-rerank-model": rr.model };
}

function optHeaders(opts: RagOptions): Record<string, string> {
  return {
    "x-opt-rewrite": opts.rewrite ? "1" : "0",
    "x-opt-graph": opts.graph ? "1" : "0",
    "x-opt-rerank": opts.rerank ? "1" : "0",
  };
}

/** 组装完整检索头：embedding 必带；chat 用于问答与图谱抽取回退；索引/重排/开关按配置附带 */
export function ragHeaders(cfg: AppConfig): Record<string, string> {
  const chat = cfg.chat.apiKey ? chatHeaders(cfg.chat) : {};
  return { ...embedHeaders(cfg.embed), ...chat, ...indexHeaders(cfg.index), ...rerankHeaders(cfg.rerank), ...optHeaders(cfg.options) };
}
