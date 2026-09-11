/**
 * @author JTP
 * @date 2026-09-11
 * @description 向量索引抽象：默认由 D1 内的分块向量本地计算，可选改用 Cloudflare Vectorize 卸载向量召回。
 *
 * 设计约束：
 * - 未绑定 Vectorize 时必须完全回退到本地计算，因此这里只在"已绑定且维度兼容"时启用。
 * - Vectorize 的写入是异步 mutation，刚写入的向量不会立即可查；调用方需要容忍短暂的不一致。
 * - 不同 Embedding 模型/维度的向量通过 namespace 隔离，避免换模型后旧向量污染检索。
 */

/** 单条待写入向量。 */
export interface VectorRecord {
  /** 向量 ID（等于分块 ID）。 */
  id: string;
  docId: string;
  seq: number;
  vector: number[];
}

/** 一次向量检索的命中结果。 */
export interface VectorMatch {
  id: string;
  docId: string;
  seq: number;
  /** 余弦相似度分数（Vectorize 度量固定为 cosine）。 */
  score: number;
}

/** 向量索引能力。 */
export interface VectorIndex {
  /** 实现标识，用于日志与诊断。 */
  readonly kind: string;
  /**
   * 索引维度。
   *
   * @returns 已配置的向量维度；读取失败或未知时返回 0，表示跳过维度前置校验并回退本地计算。
   */
  dimensions(): Promise<number>;
  /**
   * 写入（或覆盖）一批向量。
   *
   * @param records 待写入向量，ID 需全局唯一。
   * @param namespace 隔离命名空间，通常为 Embedding 指纹的短标识。
   * @throws 上游索引写入失败时抛出，由调用方决定是否降级。
   */
  upsert(records: VectorRecord[], namespace: string): Promise<void>;
  /**
   * 按向量 ID 删除。
   *
   * @param ids 待删除的向量 ID；为空时直接返回。
   */
  remove(ids: string[]): Promise<void>;
  /**
   * 相似度检索。
   *
   * @param vector 查询向量。
   * @param options.topK 返回条数上限。
   * @param options.namespace 需要检索的命名空间。
   * @returns 命中结果；缺少 docId/seq 元数据的条目会被丢弃。
   */
  query(vector: number[], options: { topK: number; namespace: string }): Promise<VectorMatch[]>;
}

/** 单次 upsert/delete 的批量上限：低于 Workers 的 1000 条限制，留出余量。 */
const MUTATION_BATCH_SIZE = 500;

/** 基于 Cloudflare Vectorize binding 的向量索引实现。 */
export class CloudflareVectorIndex implements VectorIndex {
  readonly kind = "cloudflare-vectorize";
  private cachedDimensions: number | null = null;

  /**
   * @param index 来自 Worker 绑定的 Vectorize 索引实例。
   */
  constructor(private readonly index: VectorizeIndex) {}

  /** {@inheritDoc VectorIndex.dimensions} */
  async dimensions(): Promise<number> {
    if (this.cachedDimensions === null) {
      try {
        const details = await this.index.describe();
        const config = details?.config;
        const metric = config && "metric" in config ? config.metric : undefined;
        if (metric && metric !== "cosine") {
          // 度量口径不一致时分数不可与本地余弦比较，直接回退本地计算
          console.warn(`[vectorize] 索引度量 ${metric} 与余弦口径不一致，回退本地向量检索`);
          this.cachedDimensions = 0;
        } else {
          // 维度可能为 0（索引尚未完成创建），此时按"未知"处理
          this.cachedDimensions = config && "dimensions" in config ? Number(config.dimensions) || 0 : 0;
        }
      } catch (error) {
        console.warn("[vectorize] 读取索引信息失败，回退本地向量检索:", describeError(error));
        this.cachedDimensions = 0;
      }
    }
    return this.cachedDimensions;
  }

  /** {@inheritDoc VectorIndex.upsert} */
  async upsert(records: VectorRecord[], namespace: string): Promise<void> {
    if (records.length === 0) return;
    for (let i = 0; i < records.length; i += MUTATION_BATCH_SIZE) {
      const batch = records.slice(i, i + MUTATION_BATCH_SIZE);
      await this.index.upsert(batch.map((record) => ({
        id: record.id,
        values: record.vector,
        namespace,
        metadata: { docId: record.docId, seq: record.seq },
      })));
    }
  }

  /** {@inheritDoc VectorIndex.remove} */
  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += MUTATION_BATCH_SIZE) {
      await this.index.deleteByIds(ids.slice(i, i + MUTATION_BATCH_SIZE));
    }
  }

  /** {@inheritDoc VectorIndex.query} */
  async query(vector: number[], options: { topK: number; namespace: string }): Promise<VectorMatch[]> {
    const result = await this.index.query(vector, {
      topK: options.topK,
      namespace: options.namespace,
      returnMetadata: "all",
    });
    const matches: VectorMatch[] = [];
    for (const match of result?.matches ?? []) {
      const docId = typeof match.metadata?.docId === "string" ? match.metadata.docId : "";
      const seq = Number(match.metadata?.seq);
      if (!docId || !Number.isFinite(seq)) continue;
      matches.push({ id: match.id, docId, seq, score: match.score });
    }
    return matches;
  }
}

/**
 * 按绑定创建向量索引。
 *
 * @param binding Worker 环境中的 Vectorize 绑定；未配置时为 undefined。
 * @returns 已绑定则返回实现，否则返回 null（调用方走本地计算）。
 */
export function createVectorIndex(binding: VectorizeIndex | undefined | null): VectorIndex | null {
  return binding ? new CloudflareVectorIndex(binding) : null;
}

/** 提取错误消息，避免日志里输出对象。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
