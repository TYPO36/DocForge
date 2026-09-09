import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { SqliteStorage } from "./storage/sqlite";
import * as path from "node:path";
import * as fs from "node:fs";

const PORT = Number(process.env.PORT ?? 8788);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, "docforge.db");

const storage = new SqliteStorage(DB_FILE, DATA_DIR);
// 上次进程异常退出可能遗留卡在 processing 的文档，启动时复位为 failed，便于重新索引/删除
await storage.resetStuckProcessing();
const app = createApp(storage);

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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`DocForge 已启动 → http://localhost:${info.port}（本地模式，数据目录：${DATA_DIR}）`);
});
