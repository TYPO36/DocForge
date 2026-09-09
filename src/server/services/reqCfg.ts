import type { Context } from "hono";
import type { ChatConfig, EmbedConfig, IndexConfig, RerankConfig, RagOptions } from "../../shared/types";
import { HDR } from "../../shared/types";

const h = (c: Context, name: string) => c.req.header(name) ?? "";
const isOn = (v: string) => v === "1" || v.toLowerCase() === "true";

export function chatCfgOf(c: Context): ChatConfig {
  return {
    baseUrl: h(c, HDR.chatBase) ?? "",
    apiKey: h(c, HDR.chatKey) ?? "",
    model: h(c, HDR.chatModel) ?? "",
    temperature: 0.7,
    maxTokens: 4096,
    stream: true,
  };
}

export function embedCfgOf(c: Context): EmbedConfig {
  return {
    baseUrl: h(c, HDR.embedBase) ?? "",
    apiKey: h(c, HDR.embedKey) ?? "",
    model: h(c, HDR.embedModel) ?? "",
    dimension: 0,
  };
}

export function indexCfgOf(c: Context): IndexConfig {
  return {
    baseUrl: h(c, HDR.indexBase) ?? "",
    apiKey: h(c, HDR.indexKey) ?? "",
    model: h(c, HDR.indexModel) ?? "",
  };
}

export function rerankCfgOf(c: Context): RerankConfig {
  const baseUrl = h(c, HDR.rerankBase) ?? "";
  const apiKey = h(c, HDR.rerankKey) ?? "";
  const model = h(c, HDR.rerankModel) ?? "";
  const flag = h(c, HDR.optRerank) ?? "";
  const enabled = flag ? isOn(flag) : !!(baseUrl && apiKey && model);
  return { baseUrl, apiKey, model, enabled };
}

/** 读取 x-opt-* 开关头；未显式声明时用传入默认值（默认值来自客户端设置页） */
export function optionsOf(c: Context, dflt: RagOptions): RagOptions {
  const rw = h(c, HDR.optRewrite) ?? "";
  const gp = h(c, HDR.optGraph) ?? "";
  const rr = h(c, HDR.optRerank) ?? "";
  return {
    rewrite: rw ? isOn(rw) : dflt.rewrite,
    graph: gp ? isOn(gp) : dflt.graph,
    rerank: rr ? isOn(rr) : dflt.rerank,
  };
}

/** 图谱抽取实际使用的模型 profile：优先独立索引模型；未配置时回退对话模型（会消耗对话 Token，设置页有标注） */
export function graphProfileOf(chat: ChatConfig, index: IndexConfig): { baseUrl: string; apiKey: string; model: string } | null {
  if (index.baseUrl && index.apiKey && index.model) return index;
  if (chat.baseUrl && chat.apiKey && chat.model) return { baseUrl: chat.baseUrl, apiKey: chat.apiKey, model: chat.model };
  return null;
}
