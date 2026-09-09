import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";

/**
 * DocForge 私有模式鉴权（环境变量开关）
 *
 * 设计要点：
 * - 开源默认开放：未配置 ADMIN_PASSWORD 时 enabled=false，所有请求放行（与旧行为完全一致）。
 * - docf.cc.cd 等部署只需在 Cloudflare 配置 Secret：ADMIN_PASSWORD（必填）、ADMIN_USER（可选，默认 admin）、
 *   SESSION_SECRET（可选，用于签名 Cookie；未设置时由密码派生）。
 * - 登录成功签发 HttpOnly Cookie（会话级：浏览器关闭即失效），并带服务端硬上限（默认 7 天）防无限期令牌。
 * - 密码比对使用恒定时间比较；登录失败有每 IP 限速，防暴力破解。
 * - 私有模式下除 /api/auth/login、/api/auth/me、/api/auth/logout 外，全部 /api/* 需有效会话，否则 401。
 */

export interface AuthConfig {
  enabled: boolean;
  username: string;
  password: string;
  secret: string;
}

/** Worker env 与 process.env 共用的可读字段（缺省即开放模式） */
export interface AuthEnv {
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export const COOKIE_NAME = "df_session";
/** 服务端硬上限：即使 Cookie 未设过期，超过此时长也强制重登（毫秒，默认 7 天） */
const HARD_TTL_MS = 7 * 24 * 3600 * 1000;
/** 登录限速：每 IP 15 分钟内最多失败次数 */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

export function resolveAuth(env: AuthEnv): AuthConfig {
  const password = env.ADMIN_PASSWORD;
  if (!password) return { enabled: false, username: "admin", password: "", secret: "" };
  return {
    enabled: true,
    username: env.ADMIN_USER || "admin",
    password,
    secret: env.SESSION_SECRET || ("docforge:" + password),
  };
}

// ===== HMAC-SHA256 签名工具（WebCrypto，Worker 与 Node 通用） =====

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 恒定时间字符串比较（先比长度再逐字符异或，返回前不提前退出） */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function signSession(username: string, cfg: AuthConfig): Promise<string> {
  const payload = JSON.stringify({ u: username, exp: Date.now() + HARD_TTL_MS });
  const b64 = b64urlEncode(payload);
  const sig = await hmacHex(cfg.secret, b64);
  return b64 + "." + sig;
}

/** 校验并解析会话 Cookie，返回用户名；无效/过期返回 null */
async function verifySession(value: string | undefined, cfg: AuthConfig): Promise<string | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot >= value.length - 1) return null;
  const b64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expect = await hmacHex(cfg.secret, b64);
  if (!constantTimeEqual(sig, expect)) return null;
  let payload: { u?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(b64urlDecode(b64));
  } catch {
    return null;
  }
  if (typeof payload.u !== "string" || !payload.u) return null;
  if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;
  return payload.u;
}

// ===== 路由 =====

function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function authRoutes(cfg: AuthConfig) {
  const app = new Hono();
  // 登录失败限速：ip -> { count, resetAt }（内存表；多隔离区 Worker 下为尽力而为）
  const fails = new Map<string, { count: number; resetAt: number }>();

  app.post("/login", async (c) => {
    if (!cfg.enabled) return c.json({ error: "Not Found" }, 404);
    const ip = clientIp(c);
    const rec = fails.get(ip);
    if (rec && rec.resetAt > Date.now() && rec.count >= MAX_FAILS) {
      return c.json({ error: "尝试次数过多，请 15 分钟后再试" }, 429);
    }
    let body: { username?: unknown; password?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {
      /* fallthrough */
    }
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";

    const userOk = constantTimeEqual(username, cfg.username);
    const passOk = constantTimeEqual(password, cfg.password);
    if (!userOk || !passOk) {
      const now = Date.now();
      const cur = fails.get(ip);
      const count = cur && cur.resetAt > now ? cur.count + 1 : 1;
      fails.set(ip, { count, resetAt: now + FAIL_WINDOW_MS });
      return c.json({ error: "用户名或密码错误" }, 401);
    }
    fails.delete(ip);
    const token = await signSession(cfg.username, cfg);
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      secure: isSecure(c),
      sameSite: "Lax",
      path: "/",
    });
    return c.json({ ok: true, username: cfg.username });
  });

  app.post("/logout", async (c) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/me", async (c) => {
    const cookie = getCookie(c, COOKIE_NAME);
    const authed = cfg.enabled ? Boolean(await verifySession(cookie, cfg)) : false;
    return c.json({ private: cfg.enabled, authed });
  });

  return app;
}

/** 私有模式守卫：未启用时放行一切；启用时除 auth 三个端点外所有 /api/* 需有效会话 */
export function authGuard(cfg: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!cfg.enabled) return next();
    const path = new URL(c.req.url).pathname;
    if (path === "/api/auth/login" || path === "/api/auth/me" || path === "/api/auth/logout") return next();
    const cookie = getCookie(c, COOKIE_NAME);
    const ok = cookie ? await verifySession(cookie, cfg) : null;
    if (!ok) return c.json({ error: "未登录或会话已过期，请先登录" }, 401);
    return next();
  };
}
