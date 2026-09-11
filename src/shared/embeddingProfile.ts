/**
 * @author JTP
 * @date 2026-09-11
 * @description 生成不含密钥的 Embedding 索引兼容性标识。
 */
import type { EmbedConfig } from "./types";

/**
 * 将 Embedding 配置归一化为可持久化的兼容性标识。
 * 标识不包含 API Key，仅用于检测模型、服务地址或维度变更后的重建索引需求。
 *
 * @param config Embedding 模型配置。
 * @param actualDimension 上游实际返回的向量维度；未提供时使用配置维度。
 * @returns 稳定的非敏感配置标识；配置不完整时返回空字符串。
 */
export function embeddingProfileOf(config: Pick<EmbedConfig, "baseUrl" | "model" | "dimension">, actualDimension?: number): string {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = config.model.trim();
  const dimension = actualDimension && actualDimension > 0 ? actualDimension : config.dimension;
  if (!baseUrl || !model || !Number.isFinite(dimension) || dimension <= 0) return "";
  return JSON.stringify({ baseUrl, model, dimension: Math.floor(dimension) });
}

/**
 * 规范化服务地址，保证仅末尾斜杠不同不会触发不必要的重建索引。
 *
 * @param value 用户输入的 Base URL。
 * @returns 规范化后的 URL；无法解析时仅去除首尾空白和末尾斜杠。
 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}
