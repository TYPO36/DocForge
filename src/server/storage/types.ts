import type { DocumentRow, ChunkRow } from "../db/schema";
import type { DocGraphStatus } from "../../shared/types";

export interface NewDocument {
  id: string;
  name: string;
  type: string;
  size: number;
}

// —— RAG v2 图谱数据 ——
export interface DocEntity {
  name: string;
  type?: string;
  mentions: number;
  chunkSeqs: number[];
}
export interface DocRelation {
  source: string;
  target: string;
  description: string;
}
export interface EntityRecord {
  docId: string;
  name: string;
  type: string;
  mentions: number;
  chunkSeqs: number[];
}
export interface RelationRecord {
  docId: string;
  source: string;
  target: string;
  description: string;
}

export interface GraphStatePatch {
  graphStatus?: DocGraphStatus;
  graphError?: string | null;
  entityCount?: number;
}

export interface Storage {
  createDocument(doc: NewDocument): Promise<void>;
  listDocuments(): Promise<DocumentRow[]>;
  getDocument(id: string): Promise<DocumentRow | undefined>;
  updateDocument(id: string, patch: Partial<Pick<DocumentRow, "status" | "error" | "chunkCount" | "embeddingProfile">>): Promise<void>;
  deleteDocument(id: string): Promise<void>;
  insertChunks(rows: ChunkRow[]): Promise<void>;
  listChunksByDoc(docId: string): Promise<ChunkRow[]>;
  deleteChunksByDoc(docId: string): Promise<void>;
  allChunks(): Promise<ChunkRow[]>;
  /**
   * 只查询指定文档的分块，供问答检索使用。
   * 相比 allChunks() 全表读取，可避免把不兼容或非就绪文档的分块载入内存与 D1 读取额度。
   *
   * @param docIds 参与检索的文档 ID；为空时返回空数组且不发起查询。
   * @returns 这些文档的全部分块（顺序不保证，调用方自行按 seq 归组）。
   */
  chunksByDocIds(docIds: string[]): Promise<ChunkRow[]>;
  putFile(key: string, data: ArrayBuffer | Uint8Array, contentType: string): Promise<void>;
  getFile(key: string): Promise<{ data: ArrayBuffer; contentType: string } | undefined>;
  deleteFile(key: string): Promise<void>;
  /**
   * 幂等互斥：仅当文档当前不是 processing 时，原子地将状态置为 processing 并清空错误。
   * 返回是否成功（false = 已有任务在处理中，或文档不存在）。
   */
  beginProcessing(id: string): Promise<boolean>;
  /** 服务启动时复位因异常中断而卡在 processing 的文档（置为 failed 并附原因），便于重试/删除 */
  resetStuckProcessing(): Promise<void>;
  // —— RAG v2 图谱存储 ——
  /** 整体替换某文档的图谱（删除旧行后插入），幂等 */
  replaceDocGraph(docId: string, entities: DocEntity[], relations: DocRelation[]): Promise<void>;
  deleteGraphByDoc(docId: string): Promise<void>;
  allEntities(): Promise<EntityRecord[]>;
  allRelations(): Promise<RelationRecord[]>;
  /** 只查询指定文档的图谱记录，避免问答时加载不参与检索的历史图谱。 */
  graphByDocIds(docIds: string[]): Promise<{ entities: EntityRecord[]; relations: RelationRecord[] }>;
  updateGraphState(id: string, patch: GraphStatePatch): Promise<void>;
}
