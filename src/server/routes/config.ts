import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ChatConfig, EmbedConfig, TestResult } from "../../shared/types";
import { HDR } from "../../shared/types";
import { testChat, testEmbed, AiError } from "../services/ai";

type ProbeResult = { status: ContentfulStatusCode; data: TestResult };

export function configRoutes() {
  const app = new Hono();

  // 幂等/防抖：同一 kind 的测试若已有一个请求在进行中，后续重复请求直接共享其结果，
  // 不再重复调用上游 Embedding/Chat 接口（防止按钮连点/多标签页连发）。
  const pending = new Map<"chat" | "embed", Promise<ProbeResult>>();

  // 连接测试：kind = chat | embed
  app.post("/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { kind?: string } | null;
    const kind = body?.kind === "embed" ? "embed" : "chat";
    let job = pending.get(kind);
    if (!job) {
      job = runProbe(kind, c.req.raw.headers).finally(() => pending.delete(kind));
      pending.set(kind, job);
    }
    const { status, data } = await job;
    return c.json(data, status);
  });

  return app;
}

async function runProbe(kind: "chat" | "embed", headers: Headers): Promise<ProbeResult> {
  if (kind === "embed") {
    const cfg: EmbedConfig = {
      baseUrl: headers.get(HDR.embedBase) ?? "",
      apiKey: headers.get(HDR.embedKey) ?? "",
      model: headers.get(HDR.embedModel) ?? "",
      dimension: 0,
    };
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      const r: TestResult = { ok: false, kind, message: "请先填写 Embedding 的 Base URL / API Key / 模型" };
      return { status: 400, data: r };
    }
    try {
      const { latencyMs, dimension } = await testEmbed(cfg);
      const r: TestResult = { ok: true, kind, message: `连接成功 · ${cfg.model} · 维度 ${dimension} · ${latencyMs}ms`, latencyMs, dimension };
      return { status: 200, data: r };
    } catch (e) {
      const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "连接失败";
      return { status: 502, data: { ok: false, kind, message: msg } };
    }
  } else {
    const cfg: ChatConfig = {
      baseUrl: headers.get(HDR.chatBase) ?? "",
      apiKey: headers.get(HDR.chatKey) ?? "",
      model: headers.get(HDR.chatModel) ?? "",
      temperature: 0.7, maxTokens: 5, stream: true,
    };
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      const r: TestResult = { ok: false, kind, message: "请先填写 Chat 的 Base URL / API Key / 模型" };
      return { status: 400, data: r };
    }
    try {
      const { latencyMs } = await testChat(cfg);
      const r: TestResult = { ok: true, kind, message: `连接成功 · ${cfg.model} · ${latencyMs}ms`, latencyMs };
      return { status: 200, data: r };
    } catch (e) {
      const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : "连接失败";
      return { status: 502, data: { ok: false, kind, message: msg } };
    }
  }
}
