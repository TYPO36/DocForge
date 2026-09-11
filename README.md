# DocForge · 轻量 RAG 文档问答（开源 · 免费 · 混合检索 + 图谱）

上传 PDF / DOCX / TXT 文档，通过 AI 提问检索并回答，回答附引用来源（文件 + 页码），点击可打开原文定位。

**特点**
- 🪶 轻量：无 LangChain 等重框架，纯 TS 自研，直连 OpenAI 兼容 API（chat + embedding 分开配置）
- 🔒 隐私：API Key 只存浏览器 localStorage，请求头瞬时传递，服务端零持久化
- 🏠 三端部署：本地 Node / Docker / Cloudflare Workers（免费额度）
- ⚡ SSE 流式输出、D1/SQLite 向量余弦检索（无维度限制）、引用溯源
- 🧠 RAG v2：多查询改写 + BM25/向量混合检索（RRF）+ 父子窗口 + LightRAG 式轻量图谱双级检索 +（可选）rerank 重排
- 🏷️ 全功能标注：每个能力标注「依赖哪个 Key / 开源免费 or 消耗 Token」，可独立开关，配置缺失自动降级

## 开源使用指引：你只需要在「设置」填 Key

clone 后执行 npm install 与 npm run dev 即可使用。**除 AI 对话模型外，其余全部开源免费**：

| 能力 | 要填什么 | 费用标注 | 说明 / 替代 |
  |---|---|---|---|
  | 核心问答 | 对话模型 Key（默认 DeepSeek，唯一需要付费的） | 按用量计费 | OpenAI 兼容均可 |
  | 向量化 Embedding | 硅基流动 bge-m3（默认，免费额度）或 Ollama 本地 | 免费开源 | bge-m3 为 MIT 开源模型 |
  | 多查询改写（默认开） | 复用对话模型 | 每问 ≈300~500 token（≈¥0.001） | 设置页可关 |
  | 图谱抽取（默认开） | 复用对话模型，或单独填「索引模型」指向本机 Ollama | DeepSeek ≈¥1~2 / 100 页；Ollama = ¥0 | 实体/关系抽取是 LLM 推理，embedding 干不了 |
  | 图谱检索（问答时） | 无 | ¥0（纯本地计算） | 无需任何配置 |
  | 二次重排 Rerank（默认关） | 可选：硅基流动 bge-reranker-v2-m3 免费额度或本地兼容服务 | 免费开源 | 任意 POST /rerank 兼容服务 |
  | 文档存储 / 向量库 / 图谱表 | 无 | 免费 | SQLite / D1 / R2 自带 |

所有增强能力均可在「设置 → 检索增强」开关；配置缺失时自动降级为纯向量问答，绝不阻塞使用，也绝不要求改代码。

## 快速开始（本地）

~~~bash
npm install
npm run dev        # 前端 http://localhost:5173 + API http://localhost:8788
~~~

打开 http://localhost:5173 → 设置页填入 Chat（DeepSeek 等）和 Embedding（SiliconFlow bge-m3 / Ollama）配置 → 上传文档 → 提问。

> Embedding 推荐：[SiliconFlow](https://siliconflow.cn) 的 BAAI/bge-m3（OpenAI 兼容、免费额度）；或 Ollama 本地 nomic-embed-text（完全免费离线）。注意：**DeepSeek 没有 embedding 接口**，需单独配 embedding 服务商。

## Docker

~~~bash
docker compose up -d --build
# 打开 http://localhost:8788（数据持久化在 ./data）
~~~

## 部署到 Cloudflare（免费）

前置：注册 Cloudflare 账号（免费计划即可），安装 wrangler（npm i -g wrangler 或 npx wrangler）。

~~~bash
# 1. 登录
npx wrangler login

# 2. 创建 D1 数据库与 R2 桶
npx wrangler d1 create docforge          # 输出 database_id
npx wrangler r2 bucket create docforge-files

# 3. 把 database_id 填入 wrangler.jsonc
#    "database_id": "你的D1数据库ID"

# 4. 初始化数据库表（新库：0000、0001、0002；已有旧库按顺序补执行未运行的迁移）
npx wrangler d1 execute docforge --remote --file=drizzle/0000_init.sql
npx wrangler d1 execute docforge --remote --file=drizzle/0001_rag_v2.sql
npx wrangler d1 execute docforge --remote --file=drizzle/0002_embedding_profile.sql

# 5. 构建并部署
npm run build:web
npx wrangler deploy
~~~

部署后访问 https://docforge.<你的子域>.workers.dev 。

> 数据说明：文档分块与向量存 D1（免费 5GB），图谱实体/关系存 D1，原文件存 R2（免费 10GB），均属于你的账号，仅你可见。**无需任何服务端密钥**。

### 可选：私有模式（登录墙）

默认**完全开放**（clone 即用、无登录），与开源定位一致。若你的公网部署不希望他人使用，配置两个密钥即可开启登录：
私有模式开启后：整站仅管理员可访问——所有 `/api/*` 需登录，前端自动跳转登录页。

~~~bash
# 1. 设置管理员密码（必填，开启私有模式）
npx wrangler secret put ADMIN_PASSWORD        # 输入你的密码

# 2. （可选）自定义用户名，默认 admin
npx wrangler secret put ADMIN_USER

# 3. （可选）自定义 Cookie 签名密钥；不设则由密码派生
npx wrangler secret put SESSION_SECRET
~~~

实现细节（`src/server/auth.ts`）：
- 判定依据：**存在 `ADMIN_PASSWORD` 即私有，不存在即开放**——开源部署零配置，私有部署零代码改动
- 登录成功签发 **HttpOnly Cookie**（关闭浏览器即失效，服务端 7 天硬上限）
- 密码恒定时间比较 + 每 IP 登录失败限速（10 次/15 分钟）
- 凭据只存 Cloudflare Secret，**绝不进入代码仓库**；公开代码里搜不到任何密码
- 本地验证：`ADMIN_PASSWORD=xxx npm run dev` 即启用登录墙

## 检索架构（RAG v2，纯 TS 自研）

- **A 层 · 检索质量**：多查询改写 → 向量余弦 + 本地 BM25 → RRF 倒排融合 → 父子窗口补全 → MMR-lite 去冗余 →（可选）bge-reranker 精排
- **B 层 · 轻量图谱**（LightRAG-lite）：上传时由对话/索引模型分批抽取实体与关系（chunks/8 次调用、逐批容错）；问答时零 LLM：问题词元↔实体名链接拉取实体块（具体问题级）+ 关系描述当“事实条”参与匹配（跨文档对比/归纳级）+ 一跳邻居扩展，与向量结果按块合并
- **诚实引用**：检索不到相关内容时如实回答，不硬塞引用；引用一律锚定叶子块页码，跨页窗口页首标注
- 设计存档见 docs/rag-v2-design.md（含每项能力的费用与开源标注表）

## API 摘要

| 方法 | 路径 | 说明 |
  |---|---|---|
  | POST | /api/documents | 上传（multipart file 字段），需 x-embed-*；带对话/索引模型时同步建图谱 |
  | GET | /api/documents | 文档列表（含 graphStatus / entityCount） |
  | DELETE | /api/documents/:id | 删除单个文档（真删除：索引 + 图谱 + 本地/R2 原文件） |
  | DELETE | /api/documents | 批量删除所选文档（body: {ids: string[]}，真删除） |
  | DELETE | /api/documents/all | 一键删除全部文档（真删除清空文档库） |
  | POST | /api/documents/:id/reindex | 重新索引（重建分块/向量/图谱） |
  | POST | /api/documents/:id/graph | 单独补建/重建图谱（无需重新向量化） |
  | GET | /api/documents/:id/file | 原文件下载/预览 |
  | GET | /api/documents/:id/text | 提取文本 |
  | POST | /api/chat | SSE 流式问答（RAG v2 管线） |
  | POST | /api/config/test | 连接测试（body: {kind: chat|embed}） |

AI 配置通过请求头传递：x-chat-* / x-embed-*（含 `x-embed-dimension`）/ x-index-*（图谱抽取专用模型，可选，默认回退 chat）/ x-rerank-*（可选）/ x-opt-rewrite|x-opt-graph|x-opt-rerank（"1"/"0" 开关，默认 1/1/0）。Key 不落盘。

### 更换 Embedding 后重建索引

文档会记录不含 API Key 的 Embedding 服务地址、模型和实际向量维度标识。切换其中任一项后，文档库会显示「需重建索引」；请逐个点击「重建索引」。全部现有文档均与当前模型不兼容时，问答接口会拒绝检索并明确提示此操作，避免返回看似正常但实际无关的答案。升级前创建的历史文档没有该标识，仍保持兼容，以便平滑迁移。

## 环境变量（本地/Docker）

| 变量 | 默认 | 说明 |
  |---|---|---|
  | PORT | 8788 | 服务端口 |
  | DATA_DIR | ./data | 数据目录（SQLite + 原文件） |
  | DB_FILE | ./data/docforge.db | 数据库文件 |
  | MAX_UPLOAD_MB | 20 | 上传大小上限 |

## 目录结构
~~~
src/
  server/    Hono 后端（index.worker.ts=Cloudflare / index.node.ts=Node）
    routes/  upload/chat/documents/config
    services/ parse/chunk/bm25/retrieve/rag/graph/ai/prompts/reqCfg
    storage/ d1+r2 / sqlite+fs 双实现
    db/      Drizzle schema（documents/chunks/entities/relations）
  client/    React 前端（对话 / 文档库 / 设置）
  shared/    共享类型
  docs/      design.md（v1 存档）· rag-v2-design.md（RAG v2 存档）
  ui-mockups/ Dockerfile wrangler.jsonc
~~~

## License
MIT — 可自由 clone、修改、商用；保留能力/费用/依赖透明的标注习惯，方便任何使用者只靠填 Key 上手。
