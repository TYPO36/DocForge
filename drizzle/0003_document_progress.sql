-- 处理进度持久化：前端刷新或断线后仍能看到真实阶段，不再依赖单一 HTTP 连接。
ALTER TABLE documents ADD COLUMN progress_stage TEXT;
ALTER TABLE documents ADD COLUMN progress_pct INTEGER NOT NULL DEFAULT 0;
