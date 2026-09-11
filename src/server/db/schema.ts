import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),          // pdf | docx | txt
  size: integer("size").notNull().default(0),
  status: text("status").notNull().default("processing"),
  error: text("error"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  // —— RAG v2：知识图谱状态（none=未建图 / building / ready / failed）
  graphStatus: text("graph_status").notNull().default("none"),
  graphError: text("graph_error"),
  entityCount: integer("entity_count").notNull().default(0),
  embeddingProfile: text("embedding_profile"),
  // —— 处理进度：供前端在刷新/断线后仍能看到真实阶段（null 表示当前无进行中的处理）
  progressStage: text("progress_stage"),
  progressPct: integer("progress_pct").notNull().default(0),
});

export const chunks = sqliteTable("chunks", {
  id: text("id").primaryKey(),
  docId: text("doc_id").notNull(),
  seq: integer("seq").notNull(),
  text: text("text").notNull(),
  page: integer("page"),
  tokens: integer("tokens").notNull().default(0),
  vector: text("vector").notNull(), // 向量文本：新数据为 f32:<base64>，历史数据兼容 JSON number[]
});

// —— RAG v2：LightRAG 式轻量图谱（实体名按文档记录，跨文档同名在查询期聚合）
export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  docId: text("doc_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default(""),
  mentions: integer("mentions").notNull().default(1),
  chunkSeqs: text("chunk_seqs").notNull().default("[]"), // JSON number[]：命中的叶子块 seq
});

export const relations = sqliteTable("relations", {
  id: text("id").primaryKey(),
  docId: text("doc_id").notNull(),
  source: text("source").notNull(),
  target: text("target").notNull(),
  description: text("description").notNull().default(""),
});

export type DocumentRow = typeof documents.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
export type EntityRow = typeof entities.$inferSelect;
export type RelationRow = typeof relations.$inferSelect;
