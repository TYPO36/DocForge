/**
 * @author JTP
 * @date 2026-09-11
 * @description 分块向量的紧凑编解码：用 Base64 承载 Float32 数组，并兼容历史 JSON 文本。
 *
 * 背景：分块向量原先以 JSON 数字数组存进 `chunks.vector`（TEXT 列），
 * 1024 维向量约占 9~10 KB，且每次检索都要走 JSON.parse。
 * 改为 Base64 + Float32 后体积降到约 5.4 KB（同样 1024 维），解析也更快。
 *
 * 精度说明：Float32 有约 7 位有效十进制数字，用于余弦相似度时误差量级远小于
 * 检索门槛，不影响排序结果。字节序固定按小端写入，避免依赖运行平台默认字节序。
 */

/** 紧凑编码前缀：用于与升级前写入的历史 JSON 文本区分。 */
const F32_PREFIX = "f32:";
/** 每个 Float32 的字节数。 */
const BYTES_PER_FLOAT = 4;
/** Base64 字符表（标准表，含 + /）。 */
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 反查表：下标为 ASCII 码，值为 0~63，非法字符为 -1。 */
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/**
 * 将向量编码为紧凑可存储文本。
 *
 * @param vector 向量元素；允许为空数组（编码结果为仅含前缀的空向量）。
 * @returns 形如 `f32:<base64>` 的字符串；非有限值按 0 写入，避免污染检索。
 */
export function encodeVector(vector: readonly number[]): string {
  if (vector.length === 0) return F32_PREFIX;
  const bytes = new Uint8Array(vector.length * BYTES_PER_FLOAT);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vector.length; i++) {
    const value = Number(vector[i]);
    view.setFloat32(i * BYTES_PER_FLOAT, Number.isFinite(value) ? value : 0, true);
  }
  return F32_PREFIX + bytesToBase64(bytes);
}

/**
 * 解码存储中的向量文本，同时兼容紧凑格式与升级前的 JSON 数组格式。
 *
 * @param raw `chunks.vector` 列的原始值。
 * @returns 向量数组；空值、格式非法或维度不完整时返回 null，由调用方按"无向量"处理。
 */
export function decodeVector(raw: string | null | undefined): number[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!raw.startsWith(F32_PREFIX)) return decodeLegacyJson(raw);
  const bytes = base64ToBytes(raw.slice(F32_PREFIX.length));
  if (!bytes) return null;
  if (bytes.length === 0) return [];
  if (bytes.length % BYTES_PER_FLOAT !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dimension = bytes.length / BYTES_PER_FLOAT;
  const out = new Array<number>(dimension);
  for (let i = 0; i < dimension; i++) out[i] = view.getFloat32(i * BYTES_PER_FLOAT, true);
  return out;
}

/**
 * 判断存储文本是否已使用紧凑格式（供迁移脚本或统计使用）。
 *
 * @param raw `chunks.vector` 列的原始值。
 * @returns 使用紧凑格式时为 true。
 */
export function isCompactVector(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.startsWith(F32_PREFIX);
}

/** 解析升级前写入的 JSON 数组文本；失败返回 null。 */
function decodeLegacyJson(raw: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((item) => {
      const value = Number(item);
      return Number.isFinite(value) ? value : 0;
    });
  } catch {
    return null;
  }
}

/** 将字节序列编码为带 `=` 补位的标准 Base64 文本。 */
function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    parts.push(B64_CHARS[b0 >> 2]!);
    parts.push(B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!);
    parts.push(b1 === undefined ? "=" : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!);
    parts.push(b2 === undefined ? "=" : B64_CHARS[b2 & 63]!);
  }
  return parts.join("");
}

/** 解析 Base64 文本为字节序列；遇到非法字符或残缺分组返回 null。 */
function base64ToBytes(text: string): Uint8Array | null {
  const values: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61 /* '=' 补位 */) continue;
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    const value = code < 128 ? B64_LOOKUP[code]! : -1;
    if (value < 0) return null;
    values.push(value);
  }
  if (values.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((values.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < values.length; i += 4) {
    const c0 = values[i]!;
    const c1 = values[i + 1];
    const c2 = values[i + 2];
    const c3 = values[i + 3];
    if (c1 === undefined) return null;
    out[p++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) {
      out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
      if (c3 !== undefined) out[p++] = ((c2 & 3) << 6) | c3;
    }
  }
  return p === out.length ? out : out.subarray(0, p);
}
