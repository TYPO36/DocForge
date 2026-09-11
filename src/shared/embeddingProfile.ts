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
 * 生成 Embedding 指纹的短标识，用于 Vectorize namespace 等对长度敏感的场合。
 *
 * 相同配置必然得到相同标识；不同配置碰撞概率约为 2^-64，足够用于向量空间隔离。
 *
 * @param config Embedding 模型配置。
 * @param actualDimension 上游实际返回的向量维度；未提供时使用配置维度。
 * @returns 16 位十六进制标识；配置不完整时返回空字符串。
 */
export function embeddingProfileKeyOf(config: Pick<EmbedConfig, "baseUrl" | "model" | "dimension">, actualDimension?: number): string {
  const profile = embeddingProfileOf(config, actualDimension);
  if (!profile) return "";
  return fnv1a64Hex(profile);
}

/** FNV-1a 变体：双通道 32 位哈希拼成 16 位十六进制，避免引入加密依赖。 */
function fnv1a64Hex(value: string): string {
  let forward = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    forward ^= value.charCodeAt(i);
    forward = Math.imul(forward, 0x01000193) >>> 0;
  }
  let backward = 0x9e3779b9;
  for (let i = value.length - 1; i >= 0; i--) {
    backward ^= value.charCodeAt(i);
    backward = Math.imul(backward, 0x85ebca6b) >>> 0;
  }
  return forward.toString(16).padStart(8, "0") + backward.toString(16).padStart(8, "0");
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
