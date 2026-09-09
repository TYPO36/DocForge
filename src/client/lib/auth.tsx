import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * DocForge 前端鉴权
 *
 * 服务端通过 /api/auth/me 返回 { private, authed }：
 * - private=false：开放模式（未配置 ADMIN_PASSWORD），不显示登录页，直接进入应用；
 * - private=true && authed=false：显示登录页；
 * - private=true && authed=true：进入应用。
 */

export interface AuthState {
  loading: boolean;
  privateMode: boolean;
  authed: boolean;
}

const INITIAL: AuthState = { loading: true, privateMode: false, authed: false };

async function fetchMe(): Promise<{ private: boolean; authed: boolean }> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (res.status === 404) return { private: false, authed: false }; // 兼容旧服务端
  const data = await res.json().catch(() => null);
  return { private: Boolean(data?.private), authed: Boolean(data?.authed) };
}

export async function authLogin(username: string, password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data as any)?.error ?? "登录失败");
  }
}

export async function authLogout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    /* 忽略网络错误，本地状态照常清除 */
  }
}

interface AuthCtxValue extends AuthState {
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthCtxValue | null>(null);

/** 会话失效（401）时广播，AuthProvider 监听后刷新状态踢回登录页 */
export function dispatchUnauthorized() {
  window.dispatchEvent(new Event("docforge:unauthorized"));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setState({ loading: false, privateMode: me.private, authed: me.authed });
    } catch {
      setState({ loading: false, privateMode: false, authed: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => void refresh();
    window.addEventListener("docforge:unauthorized", onUnauthorized);
    return () => window.removeEventListener("docforge:unauthorized", onUnauthorized);
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      await authLogin(username, password);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await authLogout();
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthCtxValue>(
    () => ({ ...state, refresh, login, logout }),
    [state, refresh, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthCtxValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 <AuthProvider> 内使用");
  return ctx;
}
