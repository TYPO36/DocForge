// 本地 SQLite 由 SqliteStorage 自动建表（含 RAG v2 图谱列/表）；此脚本仅用于手动初始化确认
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "docforge.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing', error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  graph_status TEXT NOT NULL DEFAULT 'none', graph_error TEXT, entity_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, seq INTEGER NOT NULL,
  text TEXT NOT NULL, page INTEGER, tokens INTEGER NOT NULL DEFAULT 0, vector TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '',
  mentions INTEGER NOT NULL DEFAULT 1, chunk_seqs TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_entities_doc ON entities(doc_id);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, description TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_relations_doc ON relations(doc_id);
`);
console.log("本地数据库初始化完成:", path.join(DATA_DIR, "docforge.db"));