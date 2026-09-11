-- Embedding 配置兼容性标识：用于提示模型或维度变更后重建索引；不存储 API Key。
ALTER TABLE documents ADD COLUMN embedding_profile TEXT;
