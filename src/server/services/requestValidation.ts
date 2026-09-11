/**
 * @author JTP
 * @date 2026-09-11
 * @description 外部请求和模型配置的统一边界校验。
 */
import { z } from "zod";
import type { ChatConfig, EmbedConfig, IndexConfig, RerankConfig } from "../../shared/types";

const MAX_URL_LENGTH = 500;
const MAX_API_KEY_LENGTH = 2_000;
const MAX_MODEL_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;

const baseUrlSchema = z.string().trim().min(1, "Base URL 不能为空").max(MAX_URL_LENGTH, "Base URL 过长").superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Base URL 仅支持 HTTP 或 HTTPS" });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Base URL 不能包含用户名或密码" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Base URL 格式无效" });
  }
});

const modelSchema = z.string().trim().min(1, "模型名称不能为空").max(MAX_MODEL_LENGTH, "模型名称过长");
const apiKeySchema = z.string().trim().min(1, "API Key 不能为空").max(MAX_API_KEY_LENGTH, "API Key 过长");

const chatRequestSchema = z.object({
  question: z.string().trim().min(1, "问题不能为空").max(12_000, "问题不能超过 12000 个字符"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1, "历史消息不能为空").max(8_000, "单条历史消息不能超过 8000 个字符"),
  })).max(12, "历史消息最多保留 12 条").optional(),
  topK: z.number().int().min(1).max(12).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(8_192).optional(),
  options: z.object({
    rewrite: z.boolean().optional(),
    graph: z.boolean().optional(),
    rerank: z.boolean().optional(),
  }).optional(),
});

type ValidationResult<T> = { value: T } | { error: string };

/**
 * 校验对话模型配置。
 *
 * @param config 来自请求头的配置。
 * @returns 通过时返回原配置，否则返回可直接展示的中文错误信息。
 */
export function validateChatConfig(config: ChatConfig): ValidationResult<ChatConfig> {
  return validateModelConfig(config);
}

/**
 * 校验 Embedding 模型配置及可选维度。
 *
 * @param config 来自请求头的配置。
 * @returns 通过时返回原配置，否则返回可直接展示的中文错误信息。
 */
export function validateEmbedConfig(config: EmbedConfig): ValidationResult<EmbedConfig> {
  const base = validateModelConfig(config);
  if ("error" in base) return base;
  if (!Number.isInteger(config.dimension) || config.dimension < 0 || config.dimension > 16_384) {
    return { error: "Embedding 维度必须是 0 到 16384 之间的整数" };
  }
  return { value: config };
}

/**
 * 校验可选的图谱抽取或重排模型配置。
 *
 * @param config 模型配置。
 * @param allowEmptyApiKey 是否允许本地兼容服务不提供 Key。
 * @returns 通过时返回原配置，否则返回错误信息。
 */
export function validateOptionalModelConfig(config: IndexConfig | RerankConfig, allowEmptyApiKey = false): ValidationResult<IndexConfig | RerankConfig> {
  const common = z.object({ baseUrl: baseUrlSchema, model: modelSchema, apiKey: allowEmptyApiKey ? z.string().trim().max(MAX_API_KEY_LENGTH, "API Key 过长") : apiKeySchema });
  const parsed = common.safeParse(config);
  return parsed.success ? { value: config } : { error: parsed.error.issues[0]?.message ?? "模型配置无效" };
}

/**
 * 校验并规范化对话请求体。
 *
 * @param body 未受信任的 JSON 请求体。
 * @returns 校验后的请求，或中文错误信息。
 */
export function parseChatRequest(body: unknown): ValidationResult<z.infer<typeof chatRequestSchema>> {
  const parsed = chatRequestSchema.safeParse(body);
  return parsed.success ? { value: parsed.data } : { error: parsed.error.issues[0]?.message ?? "请求参数无效" };
}

/**
 * 校验用于存储键的用户文件名。
 *
 * @param name 上传文件名。
 * @returns 通过时返回清理后的文件名，否则返回错误信息。
 */
export function validateFileName(name: string): ValidationResult<string> {
  const trimmed = name.trim();
  if (!trimmed) return { error: "文件名不能为空" };
  if (trimmed.length > MAX_FILE_NAME_LENGTH) return { error: "文件名不能超过 255 个字符" };
  if (trimmed === "." || trimmed === ".." || /[\\/\u0000-\u001f]/.test(trimmed)) {
    return { error: "文件名包含不允许的路径或控制字符" };
  }
  return { value: trimmed };
}

function validateModelConfig<T extends { baseUrl: string; apiKey: string; model: string }>(config: T): ValidationResult<T> {
  const parsed = z.object({ baseUrl: baseUrlSchema, apiKey: apiKeySchema, model: modelSchema }).safeParse(config);
  return parsed.success ? { value: config } : { error: parsed.error.issues[0]?.message ?? "模型配置无效" };
}
