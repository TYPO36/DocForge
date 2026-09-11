import type { Storage, RelationRecord } from "../storage/types";
import type { ChunkRow } from "../db/schema";
import type { ChatConfig, EmbedConfig, RerankConfig, RagOptions } from "../../shared/types";
import { embedTexts, retrievalPrefix, rewriteQueries, rerank as callRerank } from "./ai";
import { cosine, buildSources, type RetrievedChunk, type RetrievedFact, type DocMetaLite, type LeafSel } from "./retrieve";
import { keywordScores, tokenizeQuery } from "./bm25";
import { matchEntityRefs, matchFacts, toRetrievedFacts } from "./graph";
import { embeddingProfileOf } from "../../shared/embeddingProfile";

export interface RagStats {
  variants: string[];
  graphEntityMatches: number;
  factCount: number;
  reranked: boolean;
  compatibleDocuments: number;
  incompatibleDocuments: number;
  scannedChunks: number;
}

export interface RagResult {
  sources: RetrievedChunk[];
  facts: RetrievedFact[];
  stats: RagStats;
}

// 语义门槛（诚实性）：低于门槛的片段视为明显无关直接丢弃；全部丢弃返回空 → 助手如实回答“没有相关内容”。
const MIN_COS = 0.22;   // 向量余弦下限
const MIN_KW = 0.5;     // BM25 归一化下限（相对本库最强命中）
const MIN_FINAL = 0.18; // 融合总分下限
const RRF_K = 60;
const RRF_TOP = 160;
const WEIGHTS = [1, 0.6, 0.4];

interface Scored {
  idx: number;
  row: ChunkRow;
  maxCos: number;
  kwNorm: number;
  rrfNorm: number;
  anchor: number;
  final: number;
}

function finalScore(rrfNorm: number, maxCos: number, kwNorm: number, anchor: number): number {
  return 0.45 * rrfNorm + 0.3 * Math.max(maxCos, anchor * 0.5) + 0.2 * kwNorm + 0.05 * Math.min(anchor, 1);
}

function emptyResult(compatibleDocuments = 0, incompatibleDocuments = 0): RagResult {
  return { sources: [], facts: [], stats: { variants: [], graphEntityMatches: 0, factCount: 0, reranked: false, compatibleDocuments, incompatibleDocuments, scannedChunks: 0 } };
}

/**
 * RAG v2 主编排：改写 → 混合检索（向量余弦 + BM25 + RRF）→ 图谱通道（实体锚点块/关系事实）→ 父子窗口 →（可选 rerank）。
 * 语义标注：改写之外查询期无额外 LLM 调用；图谱通道为纯本地计算，不产生费用。
 */
export async function runRag(
  storage: Storage,
  question: string,
  chat: ChatConfig,
  embed: EmbedConfig,
  rerankCfg: RerankConfig,
  options: RagOptions,
  topK: number,
): Promise<RagResult> {
  // 1. 多查询改写（失败/未开 → 单原问，优雅降级）
  let queries = [question];
  let variants: string[] = [];
  const chatReady = !!(chat && chat.baseUrl && chat.apiKey && chat.model);
  if (options.rewrite && chatReady) {
    try {
      const rw = await rewriteQueries(chat, question);
      if (rw.length >= 2) { queries = [question, ...rw]; variants = queries; }
    } catch (e) {
      console.warn("[rag] 多查询改写失败，回退原问:", e instanceof Error ? e.message : e);
    }
  }

  // 2. 向量化（批量，带检索前缀）
  const prefixed = queries.map((q) => retrievalPrefix(embed.model) + q);
  const qVecs = await embedTexts(embed, prefixed);
  if (qVecs.length !== queries.length) throw new Error("Embedding 返回数量与查询数不一致");

  // 3. 数据装载（只取 ready 文档）
  const docs = await storage.listDocuments();
  const activeProfile = embeddingProfileOf(embed, qVecs[0]?.length);
  const metaByDoc = new Map<string, DocMetaLite>();
  let incompatibleDocuments = 0;
  for (const d of docs) {
    if (d.status !== "ready") continue;
    if (d.embeddingProfile && d.embeddingProfile !== activeProfile) {
      incompatibleDocuments++;
      continue;
    }
    metaByDoc.set(d.id, { name: d.name, type: d.type });
  }
  if (metaByDoc.size === 0) return emptyResult(0, incompatibleDocuments);
  const rows = await storage.allChunks();
  if (rows.length === 0) return emptyResult(metaByDoc.size, incompatibleDocuments);
  const n = rows.length;
  const rowsByDoc = new Map<string, ChunkRow[]>();
  const byKey = new Map<string, number>();
  const active: { idx: number; row: ChunkRow }[] = [];
  const texts = new Array<string>(n).fill("");
  rows.forEach((row, i) => {
    if (!metaByDoc.has(row.docId)) return;
    byKey.set(row.docId + ":" + row.seq, i);
    active.push({ idx: i, row });
    texts[i] = row.text ?? "";
    const arr = rowsByDoc.get(row.docId);
    if (arr) arr.push(row);
    else rowsByDoc.set(row.docId, [row]);
  });
  if (active.length === 0) return emptyResult();
  const vecCache = new Map<number, number[] | null>();
  const vecOf = (i: number): number[] | null => {
    let v = vecCache.get(i);
    if (v === undefined) {
      try { v = rows[i]?.vector ? (JSON.parse(rows[i].vector) as number[]) : null; } catch { v = null; }
      vecCache.set(i, v);
    }
    return v;
  };

  // 4. 逐 query：向量余弦 + BM25，累积 RRF
  const maxCos = new Array<number>(n).fill(0);
  const kwRaw = new Array<number>(n).fill(0);
  const rrf = new Array<number>(n).fill(0);
  let maxKwGlobal = 0;
  queries.forEach((q, qi) => {
    const w = WEIGHTS[qi] ?? 0.4;
    const qv = qVecs[qi];
    const cosArr = new Array<number>(n).fill(0);
    for (const { idx } of active) {
      const v = vecOf(idx);
      const c = v && qv ? cosine(qv, v) : 0;
      cosArr[idx] = c;
      if (c > maxCos[idx]) maxCos[idx] = c;
    }
    active.map(({ idx }) => idx).sort((a, b) => cosArr[b] - cosArr[a]).slice(0, RRF_TOP).forEach((idx, rank) => {
      rrf[idx] += w / (RRF_K + rank + 1);
    });
    const qterms = tokenizeQuery(q);
    if (qterms.length) {
      const kw = keywordScores(qterms, texts);
      for (const { idx } of active) {
        const k = kw[idx] || 0;
        if (k > kwRaw[idx]) kwRaw[idx] = k;
        if (k > maxKwGlobal) maxKwGlobal = k;
      }
      active.map(({ idx }) => idx).filter((idx) => (kw[idx] || 0) > 0).sort((a, b) => (kw[b] || 0) - (kw[a] || 0)).slice(0, RRF_TOP).forEach((idx, rank) => {
        rrf[idx] += w / (RRF_K + rank + 1);
      });
    }
  });
  const maxRrf = Math.max(...active.map(({ idx }) => rrf[idx]), 1e-6);
  const kwNormArr = new Array<number>(n).fill(0);
  if (maxKwGlobal > 0) for (const { idx } of active) kwNormArr[idx] = Math.min(1, kwRaw[idx] / maxKwGlobal);

  // 5. 图谱查询通道（纯本地，零额外 LLM）：实体锚点块（含跨文档同名聚合） + 关系事实
  const anchors = new Map<number, number>();
  const factHits: { rel: RelationRecord; score: number }[] = [];
  let graphEntityMatches = 0;
  if (options.graph) {
    try {
      const graph = await storage.graphByDocIds([...metaByDoc.keys()]);
      const ents = graph.entities;
      const rels = graph.relations;
      const matches = matchEntityRefs(question, ents);
      graphEntityMatches = matches.length;
      for (const m of matches.slice(0, 4)) {
        for (const ref of m.refs) {
          const idx = byKey.get(ref.docId + ":" + ref.seq);
          if (idx === undefined) continue;
          const v = vecOf(idx);
          const c = v && qVecs[0] ? cosine(qVecs[0], v) : 0;
          if (c > maxCos[idx]) maxCos[idx] = c;
          // 锚点强度必须与真实语义相关挂钩：只有该块与问题已有一定向量相似时才授高锚点，
          // 否则“同名实体在其它文档中被提及”的无关块会被抬进引用（产品名常跨文档出现）
          const bonus = c >= MIN_COS * 0.5 ? Math.max(m.strength, c) : c;
          const prev = anchors.get(idx);
          if (prev === undefined || bonus > prev) anchors.set(idx, bonus);
        }
      }
      factHits.push(...matchFacts(question, rels, 6));
    } catch (e) {
      console.warn("[rag] 图谱查询通道失败（忽略，纯向量仍可用）:", e instanceof Error ? e.message : e);
    }
  }

  // 6. 门槛过滤 + 融合排序
  const scored: Scored[] = [];
  for (const { idx, row } of active) {
    const cos = maxCos[idx];
    const kw = kwNormArr[idx];
    const anchor = anchors.get(idx) ?? 0;
    const isStrongAnchor = anchor >= 0.75;
    // 语义门槛（诚实性）：强锚点（图谱实体命中）只把门槛放宽 40%，
    // 不再“提及同名实体即豁免”——产品名/公司名常跨文档出现，
    // 仅提到实体但与问题语义无关的块不能因此混进引用来源。
    const gateCos = isStrongAnchor ? MIN_COS * 0.6 : MIN_COS;
    const gateKw = isStrongAnchor ? MIN_KW * 0.6 : MIN_KW;
    if (cos < gateCos && kw < gateKw) continue;
    const rrfNorm = rrf[idx] / maxRrf;
    const final = finalScore(rrfNorm, cos, kw, anchor);
    if (final < (isStrongAnchor ? 0.18 : MIN_FINAL)) continue;
    scored.push({ idx, row, maxCos: cos, kwNorm: kw, rrfNorm, anchor, final });
  }
  scored.sort((a, b) => b.final - a.final);

  // 7. 父子窗口组装引用来源（窗口文本按页标注）
  const leaves: LeafSel[] = scored.slice(0, Math.min(topK * 6, 36)).map((s) => ({ row: s.row, score: s.final }));
  let sources = buildSources(rowsByDoc, metaByDoc, leaves, topK);

  // 8. 可选 rerank（bge-reranker-v2-m3 等免费开源/兼容服务）
  let reranked = false;
  const rerankReady = rerankCfg.enabled && rerankCfg.baseUrl && rerankCfg.apiKey && rerankCfg.model;
  if (options.rerank && rerankReady && sources.length > 1) {
    try {
      const docsForRerank = sources.slice(0, 24).map((s) => s.text.slice(0, 1800));
      const res = await callRerank(rerankCfg, question, docsForRerank);
      if (res.length === docsForRerank.length) {
        const ordered = [...res]
          .sort((a, b) => b.score - a.score)
          .map((r) => ({ src: sources[r.index], score: r.score }))
          .filter((x): x is { src: RetrievedChunk; score: number } => !!x.src)
          .slice(0, topK)
          .map((x) => ({ ...x.src, score: x.score }));
        if (ordered.length > 0) { sources = ordered; reranked = true; }
      }
    } catch (e) {
      console.warn("[rag] rerank 失败，保留融合排序:", e instanceof Error ? e.message : e);
    }
  }

  const facts = toRetrievedFacts(factHits.slice(0, 6), metaByDoc);
  return {
    sources,
    facts,
    stats: {
      variants,
      graphEntityMatches,
      factCount: facts.length,
      reranked,
      compatibleDocuments: metaByDoc.size,
      incompatibleDocuments,
      scannedChunks: active.length,
    },
  };
}
