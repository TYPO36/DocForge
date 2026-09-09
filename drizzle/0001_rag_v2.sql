-- RAG v2 迁移：documents 增图谱状态列 + 图谱表（D1/存量 SQLite 执行；本地新库由 SqliteStorage 自动建）
ALTER TABLE documents ADD COLUMN graph_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE documents ADD COLUMN graph_error TEXT;
ALTER TABLE documents ADD COLUMN entity_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  mentions INTEGER NOT NULL DEFAULT 1,
  chunk_seqs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_entities_doc ON entities(doc_id);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_relations_doc ON relations(doc_id);
