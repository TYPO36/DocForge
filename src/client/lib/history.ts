import type { ChatMessage } from "../../shared/types";

/**
 * 历史对话的本地持久化（localStorage）。
 * 会话在第一次有用户提问后才落库；最多保留 MAX 条（按最近更新排序，超出淘汰最旧）。
 */

const KEY = "docforge:conversations:v1";
const ACTIVE_KEY = "docforge:active-conversation:v1";
const MAX = 30;

export interface StoredConv {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ConvMeta {
  id: string;
  title: string;
  updatedAt: number;
  userCount: number;
}

let cache: StoredConv[] | null = null;

function load(): StoredConv[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "[]") as StoredConv[];
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

function save() {
  const list = cache ?? [];
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      // 超出配额等异常：丢掉最旧的一条后重试
      if (list.length === 0) return;
      list.shift();
    }
  }
}

function metaOf(c: StoredConv): ConvMeta {
  return {
    id: c.id,
    title: c.title || "新对话",
    updatedAt: c.updatedAt,
    userCount: c.messages.filter((m) => m.role === "user").length,
  };
}

/** 历史会话列表（按最近更新降序） */
export function listMeta(): ConvMeta[] {
  return load()
    .map(metaOf)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConv(id: string): StoredConv | undefined {
  return load().find((c) => c.id === id);
}

/** 更新/新建一条会话（仅在有用户消息时落库，避免堆积空会话） */
export function upsertConv(id: string, messages: ChatMessage[]) {
  if (!messages.some((m) => m.role === "user")) return;
  const l = load();
  const idx = l.findIndex((c) => c.id === id);
  const rec: StoredConv = {
    id,
    title: (messages.find((m) => m.role === "user")?.content ?? "").replace(/\s+/g, " ").slice(0, 24),
    updatedAt: Date.now(),
    messages,
  };
  if (idx >= 0) l[idx] = rec;
  else l.push(rec);
  l.sort((a, b) => b.updatedAt - a.updatedAt);
  if (l.length > MAX) l.length = MAX;
  cache = l;
  save();
}

export function removeConv(id: string) {
  const l = load().filter((c) => c.id !== id);
  cache = l;
  save();
}

export function activeId(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}
export function setActiveId(id: string) {
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
}
