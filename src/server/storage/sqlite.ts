import { DatabaseSync } from "node:sqlite";
import type { DocumentRow, ChunkRow } from "../db/schema";
import type { Storage, NewDocument, DocEntity, DocRelation, EntityRecord, RelationRecord, GraphStatePatch } from "./types";
import type { DocGraphStatus } from "../../shared/types";
import * as fs from "node:fs";
import * as path from "node:path";

function uid(): string {
  try {
    const cr = (globalThis as any).crypto;
    if (cr && cr.randomUUID) return cr.randomUUID();
  } catch { /* ignore */ }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Node 内置 SQLite（无需原生编译），本地模式使用
export class SqliteStorage implements Storage {
  private db: DatabaseSync;
  private filesDir: string;

  constructor(dbPath: string, dataDir: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // RAG v2：建表包含图谱列与图谱三表（新建库一次到位）
    this.db.exec(`
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
    // 兼容 v1 存量库：documents 缺 RAG v2 列时补列（幂等）
    this.ensureColumns();
    this.filesDir = path.join(dataDir, "files");
    fs.mkdirSync(this.filesDir, { recursive: true });
  }

  private ensureColumns() {
    const cols = new Set<string>();
    for (const r of this.db.prepare("PRAGMA table_info(documents)").all() as any[]) cols.add(r.name);
    const add = (name: string, ddl: string) => { if (!cols.has(name)) this.db.exec("ALTER TABLE documents ADD COLUMN " + ddl); };
    add("graph_status", "graph_status TEXT NOT NULL DEFAULT 'none'");
    add("graph_error", "graph_error TEXT");
    add("entity_count", "entity_count INTEGER NOT NULL DEFAULT 0");
  }

  // node:sqlite 返回蛇形列名，映射为驼峰模型
  private mapDoc(r: any): DocumentRow {
    return {
      id: r.id, name: r.name, type: r.type, size: r.size, status: r.status, error: r.error,
      chunkCount: r.chunk_count, createdAt: r.created_at,
      graphStatus: (r.graph_status ?? "none") as DocGraphStatus,
      graphError: r.graph_error ?? null,
      entityCount: r.entity_count ?? 0,
    };
  }
  private mapChunk(r: any): ChunkRow {
    return { id: r.id, docId: r.doc_id, seq: r.seq, text: r.text, page: r.page, tokens: r.tokens, vector: r.vector };
  }

  private filePath(key: string) {
    const safe = key.replace(/[^a-zA-Z0-9._\/-]/g, "_");
    return path.join(this.filesDir, safe);
  }

  async createDocument(doc: NewDocument) {
    this.db.prepare("INSERT INTO documents (id, name, type, size, status, chunk_count, created_at) VALUES (?,?,?,?,'processing',0,?)")
      .run(doc.id, doc.name, doc.type, doc.size, Date.now());
  }
  async listDocuments(): Promise<DocumentRow[]> {
    return (this.db.prepare("SELECT * FROM documents ORDER BY created_at").all() as any[]).map((r) => this.mapDoc(r));
  }
  async getDocument(id: string): Promise<DocumentRow | undefined> {
    const r = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
    return r ? this.mapDoc(r) : undefined;
  }
  async updateDocument(id: string, patch: Partial<Pick<DocumentRow, "status" | "error" | "chunkCount">>) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.error !== undefined) { sets.push("error = ?"); vals.push(patch.error); }
    if (patch.chunkCount !== undefined) { sets.push("chunk_count = ?"); vals.push(patch.chunkCount); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare("UPDATE documents SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
  }
  async updateGraphState(id: string, patch: GraphStatePatch) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.graphStatus !== undefined) { sets.push("graph_status = ?"); vals.push(patch.graphStatus); }
    if (patch.graphError !== undefined) { sets.push("graph_error = ?"); vals.push(patch.graphError ?? null); }
    if (patch.entityCount !== undefined) { sets.push("entity_count = ?"); vals.push(patch.entityCount); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare("UPDATE documents SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
  }
  async deleteDocument(id: string) {
    this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(id);
    this.db.prepare("DELETE FROM entities WHERE doc_id = ?").run(id);
    this.db.prepare("DELETE FROM relations WHERE doc_id = ?").run(id);
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }
  async insertChunks(rows: ChunkRow[]) {
    const stmt = this.db.prepare("INSERT INTO chunks (id, doc_id, seq, text, page, tokens, vector) VALUES (?,?,?,?,?,?,?)");
    for (const r of rows) stmt.run(r.id, r.docId, r.seq, r.text, r.page, r.tokens, r.vector);
  }
  async listChunksByDoc(docId: string): Promise<ChunkRow[]> {
    return (this.db.prepare("SELECT * FROM chunks WHERE doc_id = ? ORDER BY seq").all(docId) as any[]).map((r) => this.mapChunk(r));
  }
  async deleteChunksByDoc(docId: string) {
    this.db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
  }
  async allChunks(): Promise<ChunkRow[]> {
    return (this.db.prepare("SELECT * FROM chunks").all() as any[]).map((r) => this.mapChunk(r));
  }

  // —— RAG v2 图谱 ——
  async replaceDocGraph(docId: string, entities: DocEntity[], relations: DocRelation[]) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM entities WHERE doc_id = ?").run(docId);
      this.db.prepare("DELETE FROM relations WHERE doc_id = ?").run(docId);
      const eStmt = this.db.prepare("INSERT INTO entities (id, doc_id, name, type, mentions, chunk_seqs) VALUES (?,?,?,?,?,?)");
      for (const e of entities) eStmt.run(uid(), docId, e.name.slice(0, 40), (e.type ?? "").slice(0, 12), e.mentions || 1, JSON.stringify(e.chunkSeqs ?? []));
      const rStmt = this.db.prepare("INSERT INTO relations (id, doc_id, source, target, description) VALUES (?,?,?,?,?)");
      for (const r of relations) rStmt.run(uid(), docId, r.source.slice(0, 40), r.target.slice(0, 40), (r.description ?? "").slice(0, 200));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async deleteGraphByDoc(docId: string) {
    this.db.prepare("DELETE FROM entities WHERE doc_id = ?").run(docId);
    this.db.prepare("DELETE FROM relations WHERE doc_id = ?").run(docId);
  }
  async allEntities(): Promise<EntityRecord[]> {
    return (this.db.prepare("SELECT doc_id, name, type, mentions, chunk_seqs FROM entities").all() as any[]).map((r) => ({
      docId: r.doc_id, name: r.name, type: r.type ?? "", mentions: r.mentions ?? 1,
      chunkSeqs: (() => {
        try { const v = JSON.parse(r.chunk_seqs ?? "[]"); return Array.isArray(v) ? v.map(Number).filter((x: number) => Number.isFinite(x)) : []; }
        catch { return []; }
      })(),
    }));
  }
  async allRelations(): Promise<RelationRecord[]> {
    return (this.db.prepare("SELECT doc_id, source, target, description FROM relations").all() as any[]).map((r) => ({
      docId: r.doc_id, source: r.source, target: r.target, description: r.description ?? "",
    }));
  }

  async putFile(key: string, data: ArrayBuffer | Uint8Array, _contentType: string) {
    const p = this.filePath(key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(new Uint8Array(data)));
  }
  async getFile(key: string) {
    const p = this.filePath(key);
    if (!fs.existsSync(p)) return undefined;
    const buf = fs.readFileSync(p);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const ext = path.extname(p).toLowerCase();
    const ct = ext === ".pdf" ? "application/pdf" : ext === ".txt" ? "text/plain; charset=utf-8" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    return { data: ab, contentType: ct };
  }
  async deleteFile(key: string) {
    const p = this.filePath(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  async beginProcessing(id: string): Promise<boolean> {
    const r = this.db
      .prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ? AND status != 'processing'")
      .run(id);
    return Number(r.changes) > 0;
  }
  async resetStuckProcessing() {
    this.db
      .prepare("UPDATE documents SET status = 'failed', error = ? WHERE status = 'processing'")
      .run("上次处理被异常中断（服务重启），可重新索引或删除后重传");
  }
}
