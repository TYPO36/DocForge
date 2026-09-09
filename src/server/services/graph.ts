import type { DocEntity, DocRelation, EntityRecord, RelationRecord } from "../storage/types";
import type { RetrievedFact, DocMetaLite } from "./retrieve";
import { tokenizeQuery } from "./bm25";
import { chatJson } from "./ai";

interface LLMProfile { baseUrl: string; apiKey: string; model: string }

const MAX_BATCH_CHARS = 5600;   // 每批总字符上限
const MAX_BATCH_CHUNKS = 8;     // 每批块数上限（Cloudflare 免费版 50 次子请求/请求内余量）
const MAX_NAME = 40;
const MAX_DESC = 120;

export interface GraphIndexResult {
  entities: DocEntity[];
  relations: DocRelation[];
}

/**
 * 图谱索引期：叶子块分批交给 LLM 做实体/关系抽取（LightRAG 式索引，纯 TS 自研）。
 * 语义标注：这是 B 层唯一消耗 LLM token 的环节（约 chunks/8 次调用）；失败批次跳过（部分图可接受）。
 * 跨批同名实体按规范化名合并；批间无状态，可随时断点续跑。
 */
export async function buildDocGraph(
  profile: LLMProfile,
  chunks: { seq: number; text: string }[],
  onBatch?: (done: number, total: number) => void,
): Promise<GraphIndexResult> {
  const batches: { seq: number; text: string }[][] = [];
  let cur: { seq: number; text: string }[] = [];
  let chars = 0;
  for (const ch of chunks) {
    if (cur.length > 0 && (chars + ch.text.length > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_CHUNKS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(ch);
    chars += ch.text.length;
  }
  if (cur.length > 0) batches.push(cur);

  const sys =
    "你是文档知识抽取器。给定若干编号文本块（[#n] 表示块号），抽取：\n" +
    "1. entities 实体：人名/组织/地点/产品名/项目名/条款/日期/金额等具体可指称的事物，输出 [{\"name\":\"原文名称\",\"type\":\"人物|组织|地点|产品|项目|条款|时间|金额|其他\"}]；\n" +
    "2. relations 关系：实体间有意义的关系（隶属、发生、约定、对比等），输出 [{\"source\":\"实体名\",\"target\":\"实体名\",\"description\":\"关系说明，一句话，≤40字\"}]，source/target 必须与本次 entities 输出中的名称完全一致。\n" +
    "要求：名称保留原文表述并去重；明显无关的文本输出空数组；只输出 JSON：{\"entities\":[],\"relations\":[]}，不要任何解释或 Markdown。";

  const entAcc = new Map<string, DocEntity>(); // key: normalized name (doc 内合并)
  const relAcc = new Map<string, DocRelation>();
  let doneBatches = 0;
  const totalBatches = batches.length;
  const tick = () => { doneBatches += 1; onBatch?.(doneBatches, totalBatches); };
  for (const batch of batches) {
    if (batch.length === 0) { tick(); continue; }
    const userText = batch.map((b) => "[#" + b.seq + "] " + b.text).join("\n\n");
    let raw = "";
    try {
      raw = await chatJson(profile, [{ role: "system", content: sys }, { role: "user", content: userText }], {
        maxTokens: 2400, temperature: 0.1, timeoutMs: 150000,
      });
    } catch (e) {
      console.warn("[graph] 抽取批次失败（跳过）:", e instanceof Error ? e.message : e);
      tick();
      continue;
    }
    // —— 解析鲁棒性：严格 JSON → 修复重试(1 次) → 正则兜底 ——
    let parsed = tryParseGraphJson(raw);
    if (!parsed) {
      // 修复重试：仅失败批次多 1 次调用（让模型把解释文本整理成纯 JSON）
      try {
        const fix = await chatJson(profile, [
          { role: "system", content: sys },
          { role: "user", content:
            "上一步输出不是严格 JSON。请把以下内容整理为唯一一个严格 JSON（{\"entities\":[{\"name\":\"\",\"type\":\"\"}],\"relations\":[{\"source\":\"\",\"target\":\"\",\"description\":\"\"}]}），丢弃解释与 Markdown，不要省略任何实体或关系：\n\n" +
            raw.slice(0, 6000) },
        ], { maxTokens: 2400, temperature: 0, timeoutMs: 150000 });
        parsed = tryParseGraphJson(fix);
      } catch { parsed = null; }
    }
    if (!parsed) parsed = salvageGraphJson(raw);
    if (!parsed || (parsed.entities.length === 0 && parsed.relations.length === 0)) {
      console.warn("[graph] 批次响应不可解析（含修复重试与正则兜底），跳过");
      tick();
      continue;
    }
    const batchNames = new Set<string>();
    const ents = parsed.entities.slice(0, 60);
    for (const e of ents) {
      const name = typeof e?.name === "string" ? e.name.trim().slice(0, MAX_NAME) : "";
      if (!name || name.length < 2) continue;
      const type = typeof e?.type === "string" ? e.type.trim().slice(0, 12) : "";
      const key = normKey(name);
      batchNames.add(key);
      const prev = entAcc.get(key);
      const seqs = batch.filter((b) => b.text.includes(name)).map((b) => b.seq);
      if (prev) {
        prev.mentions += 1;
        for (const s of seqs) if (!prev.chunkSeqs.includes(s)) prev.chunkSeqs.push(s);
        if (!prev.type && type) prev.type = type;
      } else {
        entAcc.set(key, { name, type: type || undefined, mentions: 1, chunkSeqs: seqs });
      }
    }
    // 用本批实体去重本批关系：source/target 未命中本批实体名（规范化后）则跳过
    const rels = (parsed.relations ?? []).slice(0, 60);
    for (const r of rels) {
      const src = typeof r?.source === "string" ? r.source.trim().slice(0, MAX_NAME) : "";
      const tgt = typeof r?.target === "string" ? r.target.trim().slice(0, MAX_NAME) : "";
      const desc = typeof r?.description === "string" ? r.description.trim().slice(0, MAX_DESC) : "";
      if (!src || !tgt || !desc) continue;
      // 宽容：关系两端的实体也可能只出现在其它批，若本批都没有则等合并期再验证（此处仅做跨批去重）
      void batchNames;
      const key = normKey(src) + "\u0001" + normKey(tgt);
      const prev = relAcc.get(key);
      if (prev) {
        if (prev.description !== desc && prev.description.length < 200) prev.description = prev.description + "；" + desc;
      } else {
        relAcc.set(key, { source: src, target: tgt, description: desc });
      }
    }
    tick();
  }
  const entities = [...entAcc.values()].slice(0, 1600).map((e) => ({ ...e, chunkSeqs: Array.from(new Set(e.chunkSeqs)).sort((a, b) => a - b) }));
  const relations = [...relAcc.values()].slice(0, 1600);
  return { entities, relations };
}

/** 规范化实体名：统一小写、去空白与常见中英文标点，用于跨批/跨文档合并 */
function normKey(name: string): string {
  return name.toLowerCase().replace(/[\s，。、；：,.!?;:""''()（）\[\]【】《》<>/\\-]+/g, "");
}

interface RawGraph {
  entities: { name: string; type?: string }[];
  relations: { source: string; target: string; description?: string }[];
}

/** 严格 JSON 尝试（自动裁剪到首 { 与末 }） */
function tryParseGraphJson(raw: string): RawGraph | null {
  const t = raw.trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const v = JSON.parse(t.slice(s, e + 1));
    if (v && typeof v === "object") {
      return {
        entities: Array.isArray(v.entities) ? v.entities : [],
        relations: Array.isArray(v.relations) ? v.relations : [],
      };
    }
  } catch { /* fallthrough */ }
  return null;
}

/** 正则兜底：从夹带解释文本的响应里捞取实体名/关系三元组 */
function salvageGraphJson(raw: string): RawGraph | null {
  const entities: { name: string; type?: string }[] = [];
  const relations: { source: string; target: string; description?: string }[] = [];
  const nameRe = /"name"\s*:\s*"((?:[^"\\]|\\.){2,60})"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(raw)) !== null) {
    const n = m[1];
    if (!seen.has(n)) { seen.add(n); entities.push({ name: n }); }
    if (entities.length >= 60) break;
  }
  const srcRe = /"source"\s*:\s*"((?:[^"\\]|\\.){1,60})"/g;
  const tgtRe = /"target"\s*:\s*"((?:[^"\\]|\\.){1,60})"/g;
  const descRe = /"description"\s*:\s*"((?:[^"\\]|\\.){0,140})"/g;
  const srcs = [...raw.matchAll(srcRe)].map((x) => x[1]);
  const tgts = [...raw.matchAll(tgtRe)].map((x) => x[1]);
  const descs = [...raw.matchAll(descRe)].map((x) => x[1]);
  const n = Math.max(srcs.length, tgts.length);
  for (let i = 0; i < n && relations.length < 60; i++) {
    const source = srcs[i] ?? "";
    const target = tgts[i] ?? "";
    if (source && target) relations.push({ source, target, description: descs[i] ?? "" });
  }
  if (entities.length === 0 && relations.length === 0) return null;
  return { entities, relations };
}

/** 2-gram Dice（实体链接用） */
function diceBigram(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[\s，。、；：,.!?;:""''()（）\[\]【】《》<>/\\-]+/g, "");
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

export interface EntityMatch {
  name: string;
  strength: number;
  docSpread: number;
  refs: { docId: string; seq: number }[];
}

/**
 * 查询期（零 LLM）：把问题词元与实体名做字典式匹配（子串/2-gram Dice），返回最强命中实体及其关联块引用。
 */
export function matchEntityRefs(question: string, entities: EntityRecord[]): EntityMatch[] {
  const qLower = question.toLowerCase();
  const qTokens = tokenizeQuery(question);
  const acc = new Map<string, EntityMatch>(); // key: normName
  for (const ent of entities) {
    if (!ent.name || ent.name.length < 2) continue;
    const nameL = ent.name.toLowerCase();
    let strength = 0;
    if (nameL.length >= 2 && qLower.includes(nameL)) strength = 0.98;
    else {
      const hits = qTokens.filter((t) => t.length >= 2 && nameL.includes(t)).length;
      const dice = diceBigram(qLower, nameL);
      strength = Math.max(hits > 0 ? 0.45 + 0.12 * hits : 0, dice >= 0.5 ? dice : 0);
    }
    if (strength < 0.5) continue;
    const key = normKey(ent.name);
    let m = acc.get(key);
    if (!m) {
      m = { name: ent.name, strength, docSpread: 0, refs: [] };
      acc.set(key, m);
    }
    if (strength > m.strength) m.strength = strength;
    for (const seq of ent.chunkSeqs) m.refs.push({ docId: ent.docId, seq });
  }
  const out = [...acc.values()].map((m) => ({
    ...m,
    docSpread: new Set(m.refs.map((r) => r.docId)).size,
    refs: Array.from(new Map(m.refs.map((r) => [r.docId + ":" + r.seq, r])).values()).slice(0, 24),
  }));
  out.sort((a, b) => b.strength * Math.min(b.docSpread, 3) - a.strength * Math.min(a.docSpread, 3) || b.strength - a.strength);
  return out.slice(0, 6);
}

/**
 * 查询期（零 LLM）：关系描述作为"事实条"按词元命中打分（名称命中权重更高），
 * 返回跨文档横向证据（对比/汇总类问题的主要来源）。
 */
export function matchFacts(question: string, rels: RelationRecord[], top = 6): { rel: RelationRecord; score: number }[] {
  const qTokens = tokenizeQuery(question);
  if (qTokens.length === 0) return [];
  const scored: { rel: RelationRecord; score: number }[] = [];
  for (const rel of rels) {
    if (!rel.source || !rel.target || !rel.description) continue;
    const hay = (rel.source + " " + rel.target + " " + rel.description).toLowerCase();
    let w = 0;
    for (const t of qTokens) {
      if (hay.includes(t)) w += rel.source.toLowerCase().includes(t) || rel.target.toLowerCase().includes(t) ? 2 : 1;
    }
    if (w > 0) scored.push({ rel, score: w / qTokens.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, top);
}

/** 把图谱事实转成 prompt 可用的 RetrievedFact（带文档名） */
export function toRetrievedFacts(hits: { rel: RelationRecord; score: number }[], metaByDoc: Map<string, DocMetaLite>): RetrievedFact[] {
  return hits.map((x) => ({
    docId: x.rel.docId,
    docName: metaByDoc.get(x.rel.docId)?.name ?? x.rel.docId,
    source: x.rel.source,
    target: x.rel.target,
    description: x.rel.description,
    score: x.score,
  }));
}