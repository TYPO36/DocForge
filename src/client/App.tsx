import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import ChatPage from "./pages/ChatPage";
import DocumentsPage from "./pages/DocumentsPage";
import SettingsPage from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { useAuth } from "./lib/auth";

export default function App() {
  const { loading, privateMode, authed } = useAuth();

  if (loading) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <span className="font-tech" style={{ color: "var(--dim)", fontSize: 14 }}>DocForge 加载中…</span>
      </div>
    );
  }

  // 私有模式且未登录 → 登录页（开放模式 private=false 时直接放行）
  if (privateMode && !authed) {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ChatPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
