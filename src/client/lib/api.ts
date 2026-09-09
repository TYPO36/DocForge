import type { AppConfig, ChatConfig, EmbedConfig, Citation, DocumentMeta, TestResult } from "../../shared/types";
import { ragHeaders, chatHeaders, embedHeaders } from "./config";
import { dispatchUnauthorized } from "./auth";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) dispatchUnauthorized(); // 会话过期/未登录：踢回登录页
    throw new Error((data as any)?.message ?? (data as any)?.error ?? "请求失败 (" + res.status + ")");
  }
  return data as T;
}

// ===== 文档 =====
export async function fetchDocuments(): Promise<DocumentMeta[]> {
  return json<DocumentMeta[]>("/api/documents");
}

export interface UploadResult {
  id: string;
  chunks: number;
  graphStatus?: string;
  entityCount?: number;
}

/** 服务端 NDJSON 阶段事件（与 routes/documents.ts POST 流协议对应） */
export interface UploadStageEvent {
  type: "stage";
  stage: "parse" | "chunk" | "embed" | "graph" | "finalize";
  pct?: number;          // 服务端估算处理百分比 0-100
  label?: string;        // 阶段文案（含批次数）
  done?: number;
  total?: number;
}

export interface UploadProgressCallbacks {
  /** 真实上传进度 0-100（浏览器字节级） */
  onUpload?: (pct: number) => void;
  /** 服务端每个真实子步骤完成时回调 */
  onStage?: (ev: UploadStageEvent) => void;
}

/**
 * 流式批量上传：单请求同时拿到真实上传百分比（XHR upload.onprogress）与
 * 服务端处理阶段（NDJSON 增量解析，每批 embedding / 图谱批次完成后到达），
 * 进度因此是真实波动而非写死占位。done/error 事件决定 Promise 结果。
 */
export async function uploadDocumentStreaming(
  file: File,
  cfg: AppConfig,
  cb: UploadProgressCallbacks = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    // text 响应类型保证 LOADING 阶段 responseText 逐步可见（NDJSON 增量解析的前提）
    xhr.responseType = "text";
    const headers = ragHeaders(cfg);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    // —— 真实上传进度（字节级，天然波动）——
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) cb.onUpload?.(Math.round((e.loaded / e.total) * 100));
    };

    // —— NDJSON 增量解析：只处理 responseText 中新增的完整行 ——
    let parsedLen = 0;      // 已消费到 responseText 的哪个位置（不含未完成的半行）
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const handleLines = () => {
      if (settled) return;
      const text = xhr.responseText || "";
      let idx = parsedLen;
      while (idx < text.length) {
        const nl = text.indexOf("\n", idx);
        if (nl < 0) break; // 残余半行：等待更多数据
        const line = text.slice(idx, nl).trim();
        idx = nl + 1;
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev.type !== "string") continue;
        if (ev.type === "stage") {
          cb.onStage?.(ev as UploadStageEvent);
        } else if (ev.type === "done") {
          settle(() => resolve({ id: ev.id, chunks: ev.chunks, graphStatus: ev.graphStatus, entityCount: ev.entityCount }));
          parsedLen = text.length; // 收尾
          return;
        } else if (ev.type === "error") {
          settle(() => reject(new Error(ev.message ?? "上传处理失败")));
          parsedLen = text.length;
          return;
        }
      }
      parsedLen = idx;
    };
    xhr.onreadystatechange = () => { if (xhr.readyState >= 3) handleLines(); };

    xhr.onerror = () => settle(() => reject(new Error("网络错误，上传中断")));
    xhr.onabort = () => settle(() => reject(new Error("上传已取消")));
    xhr.ontimeout = () => settle(() => reject(new Error("上传超时")));

    xhr.onload = () => {
      handleLines(); // 处理可能残余的最后几行
      if (settled) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        // 兼容旧版/其它返回纯 JSON 的服务端：直接解析
        try {
          const data = JSON.parse(xhr.responseText || "{}");
          if (data?.id) resolve({ id: data.id, chunks: data.chunks, graphStatus: data.graphStatus, entityCount: data.entityCount });
          else reject(new Error(data?.error ?? "上传失败"));
        } catch { reject(new Error("上传响应解析失败")); }
      } else {
        // 前置校验错误（400/413/422 纯 JSON）
        if (xhr.status === 401) dispatchUnauthorized();
        let msg = "上传失败 (" + xhr.status + ")";
        try {
          const data = JSON.parse(xhr.responseText || "{}");
          if (data?.error) msg = data.error;
        } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.send(fd);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  await json("/api/documents/" + id, { method: "DELETE" });
}

/** 批量删除：真删除所选多个文档（服务端级联清向量索引 + 图谱 + 本地原始文件） */
export async function deleteManyDocuments(ids: string[]): Promise<{ deleted: number }> {
  return json("/api/documents", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

/** 一键删除：真删除文档库中的全部文档 */
export async function deleteAllDocuments(): Promise<{ deleted: number }> {
  return json("/api/documents/all", { method: "DELETE" });
}

export async function reindexDocument(id: string, cfg: AppConfig): Promise<{ chunks: number; graphStatus?: string; entityCount?: number }> {
  return json("/api/documents/" + id + "/reindex", { method: "POST", headers: ragHeaders(cfg) });
}

/** 为已就绪但未建图谱/建图失败的文档单独补建图谱（需要 chat 或索引模型配置） */
export async function buildGraph(id: string, cfg: AppConfig): Promise<{ entities: number; relations: number }> {
  return json("/api/documents/" + id + "/graph", { method: "POST", headers: ragHeaders(cfg) });
}

export async function fetchDocText(id: string): Promise<{ text: string; chunks: { id: string; seq: number; text: string; page: number | null }[] }> {
  return json("/api/documents/" + id + "/text");
}

export function fileUrl(id: string): string {
  return "/api/documents/" + id + "/file";
}

// ===== Chat (SSE) =====
export interface ChatCallbacks {
  onCitations?: (cites: Citation[]) => void;
  onDelta: (text: string) => void;
  onDone: (full: string, cites: Citation[]) => void;
  onError: (message: string) => void;
}

export async function streamChat(
  question: string,
  cfg: AppConfig,
  history: { role: "user" | "assistant"; content: string }[],
  cb: ChatCallbacks,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ragHeaders(cfg) },
    body: JSON.stringify({ question, history, topK: cfg.topK || 5, temperature: cfg.chat.temperature, maxTokens: cfg.chat.maxTokens }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    if (res.status === 401) dispatchUnauthorized();
    cb.onError((data as any)?.error ?? "请求失败 (" + res.status + ")");
    return;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    const data = await res.json().catch(() => null);
    cb.onError((data as any)?.error ?? "服务返回异常");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let cites: Citation[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const payload = dataLines.join("\n");
      if (!payload) continue;
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch { continue; }
      if (event === "citations") {
        cites = parsed;
        cb.onCitations?.(cites);
      } else if (event === "delta") {
        full += parsed.text ?? "";
        cb.onDelta(parsed.text ?? "");
      } else if (event === "done") {
        cb.onDone(parsed.content ?? full, parsed.citations ?? cites);
      } else if (event === "error") {
        cb.onError(parsed.message ?? "生成失败");
      }
    }
  }
  if (full && !cites.length) cb.onDone(full, cites);
}

// ===== 配置测试 =====
export async function testConnection(kind: "chat" | "embed", chat: ChatConfig, embed: EmbedConfig): Promise<TestResult> {
  const headers = kind === "chat" ? chatHeaders(chat) : embedHeaders(embed);
  return json<TestResult>("/api/config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ kind }),
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
