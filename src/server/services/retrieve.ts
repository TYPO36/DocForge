import type { ChunkRow } from "../db/schema";
import type { Citation } from "../../shared/types";

export function cosine(a: number[], b: number[]): number {
  // 维度不一致说明用了不同模型/改了模型未重索引，结果不可信，直接按 0 处理（会被门槛过滤掉）
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** v1 兼容常量（旧引用文案使用）；v2 的语义门槛见 rag.ts */
export const MIN_SIM = 0.3;

/** 引用来源（保持 v1 的 UI 契约：一条引用 = 一份文档的一个/多个相邻片段窗口） */
export interface RetrievedChunk {
  chunkId: string;
  docId: string;
  docName: string;
  type: string;
  page: number | null;
  /** 合并后该来源涉及的全部页码（跨页合并时列出） */
  pages?: number[];
  text: string;
  score: number;
}

/** 图谱"关系事实"（文档级证据，用于跨文档对比/归纳的引导；无页码锚点，正文以《文档名》标注） */
export interface RetrievedFact {
  docId: string;
  docName: string;
  source: string;
  target: string;
  description: string;
  score: number;
}

/** 父子窗口分组：同文档相邻 PARENT_WIN 个叶子块视为一个父窗口 */
export const PARENT_WIN = 4;
export function seqGroup(seq: number): number {
  return Math.floor(seq / PARENT_WIN);
}

export interface DocMetaLite {
  name: string;
  type: string;
}

const MAX_SOURCE_TEXT = 3200; // 单个来源合并后的文本上限（字符）

/** 2-gram Dice 相似度（MMR-lite 去冗余用） */
function dice(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, " ").toLowerCase();
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

export interface LeafSel {
  row: ChunkRow;
  score: number;
}

/**
 * 把入选叶子块组装为引用来源：
 * 1. 同文档按父窗口（相邻 PARENT_WIN 块）归组并补齐窗口内其余块 → 上下文更完整（父子窗口）；
 * 2. 窗口文本跨页时在页首标注（第 N 页）；
 * 3. MMR-lite：与已保留来源高度重复（Dice>0.93）的整窗丢弃（仅作用于非最高分组）；
 * 4. 按组内最高分排序，截断 topK 条。
 */
export function buildSources(
  rowsByDoc: Map<string, ChunkRow[]>,
  metaByDoc: Map<string, DocMetaLite>,
  leaves: LeafSel[],
  topK: number,
): RetrievedChunk[] {
  if (leaves.length === 0) return [];
  interface Group { docId: string; key: number; members: ChunkRow[]; maxScore: number }
  const groups = new Map<string, Group>();
  for (const { row, score } of leaves) {
    const key = seqGroup(row.seq);
    const gid = row.docId + ":" + key;
    let g = groups.get(gid);
    if (!g) {
      g = { docId: row.docId, key, members: [], maxScore: 0 };
      groups.set(gid, g);
      const docRows = rowsByDoc.get(row.docId);
      if (docRows) {
        const start = key * PARENT_WIN;
        for (let i = start; i < Math.min(start + PARENT_WIN, docRows.length); i++) g.members.push(docRows[i]);
      }
    }
    if (score > g.maxScore) g.maxScore = score;
  }
  const sorted = [...groups.values()].sort((a, b) => b.maxScore - a.maxScore);
  const picked: { text: string; members: ChunkRow[]; maxScore: number }[] = [];
  for (const g of sorted) {
    const text = windowText(g.members);
    if (!text) continue;
    let dup = false;
    if (picked.length > 0 && g.maxScore < picked[0].maxScore) {
      for (const p of picked) if (dice(p.text, text) > 0.93) { dup = true; break; }
    }
    if (dup) continue;
    picked.push({ text, members: g.members, maxScore: g.maxScore });
  }
  picked.sort((a, b) => b.maxScore - a.maxScore);
  const out: RetrievedChunk[] = [];
  for (const p of picked.slice(0, topK)) {
    const pages = Array.from(new Set(p.members.map((m) => m.page).filter((x): x is number => x != null))).sort((a, b) => a - b);
    const carrier = p.members[0];
    const meta = metaByDoc.get(carrier.docId);
    out.push({
      chunkId: carrier.id,
      docId: carrier.docId,
      docName: meta?.name ?? carrier.docId,
      type: meta?.type ?? "",
      page: pages.length === 1 ? pages[0] : null,
      pages: pages.length > 0 ? pages : undefined,
      text: p.text,
      score: p.maxScore,
    });
  }
  return out;
}

/** 窗口文本：成员逐块拼接，页码变化时在页首标注（第 N 页） */
function windowText(members: ChunkRow[]): string {
  const ordered = [...members].sort((a, b) => a.seq - b.seq);
  const parts: string[] = [];
  let lastPage: number | null | undefined = undefined;
  for (const m of ordered) {
    const t = (m.text ?? "").trim();
    if (!t) continue;
    if (m.page != null && m.page !== lastPage) parts.push(`（第 ${m.page} 页）`);
    parts.push(t);
    lastPage = m.page ?? lastPage;
  }
  let text = parts.join("\n\n").trim();
  if (text.length > MAX_SOURCE_TEXT) text = text.slice(0, MAX_SOURCE_TEXT) + "\n…（同来源其余片段略）";
  return text;
}

export function toCitations(items: RetrievedChunk[]): Citation[] {
  return items.map((i) => ({
    docId: i.docId, docName: i.docName, type: i.type as Citation["type"],
    page: i.page, pages: i.pages, text: i.text.slice(0, 180), score: i.score, chunkId: i.chunkId,
  }));
}
