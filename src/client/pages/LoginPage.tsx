import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { I } from "../components/Icons";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      // 成功：AuthProvider.refresh 已把 authed 置为 true，主界面自动渲染
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(160deg, #f6f9ff 0%, #eef3fb 100%)",
        padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        className="card"
        style={{
          width: 380,
          maxWidth: "100%",
          padding: "34px 32px 26px",
          boxShadow: "0 20px 50px rgba(0,50,150,.12)",
          border: "1px solid rgba(0,102,240,.14)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 6 }}>
          <div
            className="logo-mark"
            style={{ width: 34, height: 34, borderRadius: 10, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <I.Logo />
          </div>
          <span className="font-tech" style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-.4px" }}>
            DocForge
          </span>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--dim)", margin: "2px 0 22px", lineHeight: 1.6 }}>
          此站点为私有部署，登录后方可使用
        </p>

        <div className="field">
          <label>用户名</label>
          <div className="input">
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoComplete="username"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="field">
          <label>密码</label>
          <div className="input">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
            />
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 12, lineHeight: 1.5 }}>{error}</div>
        )}

        <button type="submit" className="btn-primary" disabled={busy || !username.trim() || !password} style={{ width: "100%" }}>
          {busy ? "登录中…" : "登 录"}
        </button>
      </form>
    </div>
  );
}
