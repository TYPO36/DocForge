import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, ne } from "drizzle-orm";
import { documents, chunks, entities, relations, type DocumentRow, type ChunkRow } from "../db/schema";
import type { Storage, NewDocument, DocEntity, DocRelation, EntityRecord, RelationRecord, GraphStatePatch } from "./types";

function uid(): string {
  try {
    const cr = (globalThis as any).crypto;
    if (cr && cr.randomUUID) return cr.randomUUID();
  } catch { /* ignore */ }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface CfBindings {
  DB: D1Database;
  /** R2 可选：未绑定（账号未启用 R2）时降级为不持久化原文件，索引/问答不受影响 */
  FILES?: R2Bucket;
}

export class D1Storage implements Storage {
  private db: ReturnType<typeof drizzle>;
  private r2: R2Bucket | undefined;
  constructor(bindings: CfBindings) {
    this.db = drizzle(bindings.DB);
    this.r2 = bindings.FILES;
  }
  async createDocument(doc: NewDocument) {
    await this.db.insert(documents).values({
      id: doc.id, name: doc.name, type: doc.type, size: doc.size,
      status: "processing", chunkCount: 0, createdAt: Date.now(),
    });
  }
  async listDocuments() {
    return this.db.select().from(documents).orderBy(documents.createdAt);
  }
  async getDocument(id: string) {
    const rows = await this.db.select().from(documents).where(eq(documents.id, id));
    return rows[0];
  }
  async updateDocument(id: string, patch: Partial<Pick<DocumentRow, "status" | "error" | "chunkCount" | "embeddingProfile" | "progressStage" | "progressPct">>) {
    await this.db.update(documents).set(patch).where(eq(documents.id, id));
  }
  async updateGraphState(id: string, patch: GraphStatePatch) {
    const set: Partial<typeof documents.$inferInsert> = {};
    if (patch.graphStatus !== undefined) (set as any).graphStatus = patch.graphStatus;
    if (patch.graphError !== undefined) (set as any).graphError = patch.graphError ?? null;
    if (patch.entityCount !== undefined) (set as any).entityCount = patch.entityCount;
    if (Object.keys(set).length > 0) await this.db.update(documents).set(set as any).where(eq(documents.id, id));
  }
  async deleteDocument(id: string) {
    await this.db.delete(chunks).where(eq(chunks.docId, id));
    await this.db.delete(entities).where(eq(entities.docId, id));
    await this.db.delete(relations).where(eq(relations.docId, id));
    await this.db.delete(documents).where(eq(documents.id, id));
  }
  async insertChunks(rows: ChunkRow[]) {
    if (rows.length === 0) return;
    await this.db.insert(chunks).values(rows);
  }
  async listChunksByDoc(docId: string) {
    return this.db.select().from(chunks).where(eq(chunks.docId, docId)).orderBy(chunks.seq);
  }
  async deleteChunksByDoc(docId: string) {
    await this.db.delete(chunks).where(eq(chunks.docId, docId));
  }
  async allChunks() {
    return this.db.select().from(chunks);
  }
  async chunksByDocIds(docIds: string[]): Promise<ChunkRow[]> {
    if (docIds.length === 0) return [];
    // D1 单条查询的绑定参数上限为 100，超过后必须分批，否则直接报错。
    const batches = chunkIds(docIds, 100);
    const rowSets = await Promise.all(
      batches.map((ids) => this.db.select().from(chunks).where(inArray(chunks.docId, ids))),
    );
    return rowSets.flat();
  }

  // —— RAG v2 图谱（表结构由 drizzle/0001_rag_v2.sql 迁移；本地自动建） ——
  async replaceDocGraph(docId: string, ents: DocEntity[], rels: DocRelation[]) {
    await this.db.delete(entities).where(eq(entities.docId, docId));
    await this.db.delete(relations).where(eq(relations.docId, docId));
    if (ents.length > 0) {
      await this.db.insert(entities).values(ents.map((e) => ({
        id: uid(), docId, name: e.name.slice(0, 40), type: (e.type ?? "").slice(0, 12), mentions: e.mentions || 1, chunkSeqs: JSON.stringify(e.chunkSeqs ?? []),
      })));
    }
    if (rels.length > 0) {
      await this.db.insert(relations).values(rels.map((r) => ({
        id: uid(), docId, source: r.source.slice(0, 40), target: r.target.slice(0, 40), description: (r.description ?? "").slice(0, 200),
      })));
    }
  }
  async deleteGraphByDoc(docId: string) {
    await this.db.delete(entities).where(eq(entities.docId, docId));
    await this.db.delete(relations).where(eq(relations.docId, docId));
  }
  async allEntities(): Promise<EntityRecord[]> {
    const rows = await this.db.select().from(entities);
    return rows.map((r) => ({
      docId: r.docId, name: r.name, type: r.type ?? "", mentions: r.mentions ?? 1,
      chunkSeqs: (() => {
        try { const v = JSON.parse(r.chunkSeqs ?? "[]"); return Array.isArray(v) ? v.map(Number).filter((x: number) => Number.isFinite(x)) : []; }
        catch { return []; }
      })(),
    }));
  }
  async allRelations(): Promise<RelationRecord[]> {
    const rows = await this.db.select().from(relations);
    return rows.map((r) => ({ docId: r.docId, source: r.source, target: r.target, description: r.description ?? "" }));
  }
  async graphByDocIds(docIds: string[]): Promise<{ entities: EntityRecord[]; relations: RelationRecord[] }> {
    if (docIds.length === 0) return { entities: [], relations: [] };
    const batches = chunkIds(docIds, 100);
    const [entityRows, relationRows] = await Promise.all([
      Promise.all(batches.map((ids) => this.db.select().from(entities).where(inArray(entities.docId, ids)))).then((rows) => rows.flat()),
      Promise.all(batches.map((ids) => this.db.select().from(relations).where(inArray(relations.docId, ids)))).then((rows) => rows.flat()),
    ]);
    return {
      entities: entityRows.map((r) => ({
        docId: r.docId, name: r.name, type: r.type ?? "", mentions: r.mentions ?? 1,
        chunkSeqs: parseChunkSeqs(r.chunkSeqs),
      })),
      relations: relationRows.map((r) => ({ docId: r.docId, source: r.source, target: r.target, description: r.description ?? "" })),
    };
  }

  async putFile(key: string, data: ArrayBuffer | Uint8Array, contentType: string) {
    if (!this.r2) return; // 未启用 R2：跳过原文件持久化（上传/索引/问答不受影响）
    await this.r2.put(key, data, { httpMetadata: { contentType } });
  }
  async getFile(key: string) {
    if (!this.r2) return undefined;
    const obj = await this.r2.get(key);
    if (!obj) return undefined;
    return { data: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }
  async deleteFile(key: string) {
    if (!this.r2) return;
    await this.r2.delete(key);
  }
  async beginProcessing(id: string): Promise<boolean> {
    const res = await this.db
      .update(documents)
      .set({ status: "processing", error: null })
      .where(and(eq(documents.id, id), ne(documents.status, "processing")))
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
  async resetStuckProcessing() {
    await this.db
      .update(documents)
      .set({ status: "failed", progressStage: null, progressPct: 0, error: "上次处理被异常中断，可重新索引或删除后重传" })
      .where(eq(documents.status, "processing"));
  }
}

function chunkIds(ids: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size));
  return batches;
}

function parseChunkSeqs(value: string | null): number[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.map(Number).filter((item: number) => Number.isFinite(item)) : [];
  } catch {
    return [];
  }
}
