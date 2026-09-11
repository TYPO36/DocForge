import { createApp } from "./app";
import { D1Storage, type CfBindings } from "./storage/d1";
import { createWorkerScheduler } from "./services/taskScheduler";
import { createVectorIndex } from "./services/vectorIndex";

export interface Env extends CfBindings {
  ASSETS: Fetcher;
  /** 私有模式（可选）：配置后整站需登录；未配置=完全开放 */
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      // 索引任务交给 waitUntil 托管：响应返回或客户端断开后仍会继续（平台限制为最多再运行 30 秒）
      const app = createApp(
        new D1Storage(env),
        env,
        createWorkerScheduler(ctx.waitUntil.bind(ctx)),
        createVectorIndex(env.VECTORIZE),
      );
      return app.fetch(request, env, ctx);
    }
    // 静态资源（前端构建产物 dist/）由 ASSETS binding 托管
    return env.ASSETS.fetch(request);
  },
};
