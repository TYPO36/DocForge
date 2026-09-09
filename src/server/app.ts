import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Storage } from "./storage/types";
import { documentsRoutes } from "./routes/documents";
import { chatRoutes } from "./routes/chat";
import { configRoutes } from "./routes/config";

export function createApp(storage: Storage) {
  const app = new Hono<{ Variables: { storage: Storage } }>();
  app.use("*", cors());
  app.use("*", async (c, next) => {
    c.set("storage", storage);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));
  app.route("/api/documents", documentsRoutes(storage));
  app.route("/api/chat", chatRoutes(storage));
  app.route("/api/config", configRoutes());

  // 404
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  return app;
}
