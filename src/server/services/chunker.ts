// 轻量分块器：按段落/句子边界切分，支持重叠
export interface Chunk {
  text: string;
  page?: number | null;
}

const DEFAULT_CHUNK_SIZE = 600;   // 字符数（中文场景）
const DEFAULT_OVERLAP = 120;

export function estimateTokens(text: string): number {
  // 中英混合粗略估计：CJK 字符≈1 token，其余≈4 字符/token
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.9 + other / 4);
}

export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const out: Chunk[] = [];
  let start = 0;
  const n = normalized.length;
  while (start < n) {
    let end = Math.min(start + size, n);
    // 在 [start+size*0.5, end] 范围内找段落/句子边界
    if (end < n) {
      const window = normalized.slice(start + Math.floor(size * 0.5), end);
      const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("."), window.lastIndexOf("；"), window.lastIndexOf(";"), window.lastIndexOf("！"), window.lastIndexOf("?")];
      const best = Math.max(...candidates.filter((c) => c >= 0));
      if (best >= 0) end = start + Math.floor(size * 0.5) + best + 1;
    }
    const chunkText = normalized.slice(start, end).trim();
    if (chunkText) out.push({ text: chunkText });
    if (end >= n) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

// PDF 分页分块：pages 为每页文本数组
export function chunkPages(pages: string[], opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const out: Chunk[] = [];
  // 逐页分块，块尽量不跨页；若单页文本过长则切分并标注页码
  for (let i = 0; i < pages.length; i++) {
    const pageText = (pages[i] ?? "").replace(/\r\n/g, "\n").trim();
    if (!pageText) continue;
    if (pageText.length <= size) {
      out.push({ text: pageText, page: i + 1 });
      continue;
    }
    // 长页：按段落切
    const paras = pageText.split(/\n{2,}/).filter((p) => p.trim());
    let buf = "";
    for (const para of paras) {
      if (buf && buf.length + para.length > size) {
        out.push({ text: buf.trim(), page: i + 1 });
        buf = para;
      } else {
        buf = buf ? buf + "\n\n" + para : para;
      }
    }
    if (buf.trim()) out.push({ text: buf.trim(), page: i + 1 });
    // overlap 处理：若上页末块与下页首块太近，简化处理（MVP 不做跨页 overlap）
  }
  void overlap;
  return out;
}
