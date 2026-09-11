import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { SqliteStorage } from "./storage/sqlite";
import { NodeTaskQueue } from "./services/taskScheduler";
import * as path from "node:path";
import * as fs from "node:fs";

const PORT = Number(process.env.PORT ?? 8788);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, "docforge.db");

const storage = new SqliteStorage(DB_FILE, DATA_DIR);
// 上次进程异常退出可能遗留卡在 processing 的文档，启动时复位为 failed，便于重新索引/删除
await storage.resetStuckProcessing();
// 后台索引用进程内队列：客户端断开后任务继续执行，并发上限限制内存与上游速率压力
const scheduler = new NodeTaskQueue(Number(process.env.INDEX_CONCURRENCY ?? 2));
const app = createApp(storage, process.env, scheduler);

// 生产模式托管前端静态资源
const distDir = path.join(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use("*", serveStatic({ root: distDir }));
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api")) return c.notFound();
    // SPA fallback
    const file = path.join(distDir, "index.html");
    return fs.existsSync(file) ? c.html(fs.readFileSync(file, "utf8")) : c.text("前端未构建，请先运行 npm run build:web", 200);
  });
}

// 收到退出信号时先让进行中的索引任务收敛，避免留下半成品文档
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`收到 ${signal}，等待索引任务收敛…`);
    void scheduler.drain(10_000).then((done) => {
      if (!done) console.warn("仍有索引任务未完成，强制退出（可稍后重新索引）");
      process.exit(0);
    });
  });
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DocForge 已启动 → http://localhost:${info.port}（本地模式，数据目录：${DATA_DIR}）`);
});
