// ===== 共享类型 =====
export type FileType = "pdf" | "docx" | "txt";
export type DocStatus = "processing" | "ready" | "failed";
/** 知识图谱索引状态：none=未建图（纯向量） · building=建图中 · ready=可用 · failed=抽取失败可重试 */
export type DocGraphStatus = "none" | "building" | "ready" | "failed";

export interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
}

export interface EmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
}

/**
 * 图谱抽取用的「索引模型」覆盖（可选）。
 * 留空 = 回退用对话模型（会消耗对话 Token）；填本机 Ollama 等即免费抽取。
 * 语义标注：实体/关系抽取是 LLM 推理任务，embedding 模型无法承担。
 */
export interface IndexConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 二次重排（可选）。默认推荐免费开源 bge-reranker-v2-m3（硅基流动免费额度或本地兼容服务）。 */
export interface RerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

/** 检索增强开关（全部可关闭；关闭即回到 v1 纯向量行为） */
export interface RagOptions {
  /** 多查询改写：每问多消耗一次 chat 调用（约 300~500 token） */
  rewrite: boolean;
  /** 上传/重索引时同步抽取知识图谱（消耗抽取模型 Token，详见 IndexConfig） */
  graph: boolean;
  /** 二次重排（需要 Rerank 配置） */
  rerank: boolean;
}

export interface AppConfig {
  chat: ChatConfig;
  embed: EmbedConfig;
  index: IndexConfig;
  rerank: RerankConfig;
  options: RagOptions;
  topK: number;
}

export interface DocumentMeta {
  id: string;
  name: string;
  type: FileType;
  size: number;
  status: DocStatus;
  chunkCount: number;
  error?: string | null;
  createdAt: string;
  graphStatus?: DocGraphStatus;
  entityCount?: number;
  graphError?: string | null;
  /** 文档索引使用的非敏感 Embedding 配置标识；为空表示历史文档尚未记录。 */
  embeddingProfile?: string | null;
  /** 当前处理阶段（parse/chunk/embed/graph/finalize）；为空表示没有进行中的处理。 */
  progressStage?: string | null;
  /** 当前处理进度百分比（0-100）。 */
  progressPct?: number;
}

export interface ChunkInfo {
  id: string;
  docId: string;
  seq: number;
  text: string;
  page?: number | null;
  tokens: number;
}

export interface Citation {
  docId: string;
  docName: string;
  type: FileType;
  page?: number | null;
  /** 该引用覆盖的全部页码（同文档跨页合并时列出，如 [3, 7]） */
  pages?: number[];
  text: string;
  score: number;
  chunkId: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export interface TestResult {
  ok: boolean;
  kind: "chat" | "embed";
  message: string;
  latencyMs?: number;
  dimension?: number;
}

// 请求头中携带的 AI 配置（Key 只在请求头，服务端不落盘）
export const HDR = {
  chatBase: "x-chat-base-url",
  chatKey: "x-chat-api-key",
  chatModel: "x-chat-model",
  embedBase: "x-embed-base-url",
  embedKey: "x-embed-api-key",
  embedModel: "x-embed-model",
  embedDimension: "x-embed-dimension",
  // —— RAG v2：可选配置头（未填则回退/关闭对应能力）
  indexBase: "x-index-base-url",     // 图谱抽取专用模型（默认回退 chat）
  indexKey: "x-index-api-key",
  indexModel: "x-index-model",
  rerankBase: "x-rerank-base-url",   // 二次重排（免费开源 bge-reranker）
  rerankKey: "x-rerank-api-key",
  rerankModel: "x-rerank-model",
  optRewrite: "x-opt-rewrite",       // "1"/"0"
  optGraph: "x-opt-graph",
  optRerank: "x-opt-rerank",
} as const;

export interface ChatRequest {
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
  topK?: number;
  temperature?: number;
  maxTokens?: number;
  options?: Partial<RagOptions>;
}

export interface ChatSSEEvent {
  event: "citations" | "delta" | "done" | "error";
  data: unknown;
}
