import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Storage } from "./storage/types";
import { documentsRoutes } from "./routes/documents";
import { chatRoutes } from "./routes/chat";
import { configRoutes } from "./routes/config";
import { authRoutes, authGuard, resolveAuth, type AuthConfig, type AuthEnv } from "./auth";
import { detachedScheduler, type TaskScheduler } from "./services/taskScheduler";

export function createApp(storage: Storage, authEnv?: AuthEnv, scheduler: TaskScheduler = detachedScheduler) {
  const auth: AuthConfig = resolveAuth(authEnv ?? {});
  const app = new Hono<{ Variables: { storage: Storage } }>();
  app.use("*", cors());
  app.use("*", async (c, next) => {
    c.set("storage", storage);
    await next();
  });

  // 私有模式守卫：enabled=false（未配置 ADMIN_PASSWORD）时对所有请求放行
  app.use("/api/*", authGuard(auth));

  app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));
  // /api/auth/me 在开放模式也返回 { private:false }，供前端判断是否需要登录页
  app.route("/api/auth", authRoutes(auth));
  app.route("/api/documents", documentsRoutes(storage, scheduler));
  app.route("/api/chat", chatRoutes(storage));
  app.route("/api/config", configRoutes());

  // 404
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  return app;
}
