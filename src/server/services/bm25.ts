// 轻量 BM25（本地实现，零依赖、零成本）：查询分词（英文词 + CJK 相邻二元组）→ 文档内词频 → IDF。
// 语义标注：纯本地计算，不调用任何外部模型/服务。
export function tokenizeQuery(text: string): string[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  const set = new Set<string>(words);
  for (const w of words) {
    if (/[\u4e00-\u9fff]/.test(w)) {
      // 中文整词拆成相邻二元组，覆盖"加沙""哈马斯"这类不带空格的专名与书写变体
      for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
    }
  }
  return [...set];
}

/**
 * 对一批文本按查询词计算 BM25 原始分（未命中为 0）。
 * 语料统计（df / avgdl）由本次调用内的单遍扫描完成，无需预建倒排索引。
 * 注意：avgdl 用真实语料均值；本函数复杂度 O(terms × chunks × 文本长度)，适合个人/小团队语料库量级。
 */
export function keywordScores(qterms: string[], texts: string[]): number[] {
  const n = texts.length;
  const out = new Array<number>(n).fill(0);
  if (qterms.length === 0 || n === 0) return out;
  const lower: string[] = new Array(n);
  let totalChars = 0;
  for (let i = 0; i < n; i++) {
    const l = (texts[i] ?? "").toLowerCase();
    lower[i] = l;
    totalChars += l.length;
  }
  const df = new Map<string, number>();
  const hits: Map<string, number>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const l = lower[i];
    const h = new Map<string, number>();
    hits[i] = h;
    for (const t of qterms) {
      if (h.size > 24) break; // 每块最多 24 个命中词，控制开销
      let idx = 0, count = 0;
      while ((idx = l.indexOf(t, idx)) !== -1) {
        count++;
        idx += Math.max(1, t.length);
        if (count >= 12) break;
      }
      if (count > 0) {
        h.set(t, count);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const avgdl = totalChars / Math.max(1, n);
  const k1 = 1.5, b = 0.75;
  for (let i = 0; i < n; i++) {
    const h = hits[i];
    if (!h || h.size === 0) continue;
    const dl = Math.max(1, lower[i].length);
    let s = 0;
    for (const [t, c] of h) {
      const f = df.get(t) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (n - f + 0.5) / (f + 0.5));
      s += idf * ((c * (k1 + 1)) / (c + k1 * (1 - b + (b * dl) / avgdl)));
    }
    out[i] = s;
  }
  return out;
}
