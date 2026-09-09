import { createApp } from "./app";
import { D1Storage, type CfBindings } from "./storage/d1";

export interface Env extends CfBindings {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      const app = createApp(new D1Storage(env));
      return app.fetch(request, env, ctx);
    }
    // 静态资源（前端构建产物 dist/）由 ASSETS binding 托管
    return env.ASSETS.fetch(request);
  },
};
