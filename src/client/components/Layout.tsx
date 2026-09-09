import { NavLink, Outlet } from "react-router-dom";
import { I } from "./Icons";
import { useAuth } from "../lib/auth";

const tabs = [
  { to: "/", label: "对话", icon: <I.Chat size={14} /> },
  { to: "/documents", label: "文档库", icon: <I.DocGrid size={14} /> },
  { to: "/settings", label: "设置", icon: <I.Settings size={14} /> },
];

export function Layout() {
  const { privateMode, logout } = useAuth();
  return (
    <div className="app" style={{ flexDirection: "column" }}>
      <header className="topbar">
        <NavLink to="/" className="logo" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="logo-mark"><I.Logo /></div>
          <span className="font-tech">DocForge</span>
        </NavLink>

        <nav className="nav-tabs">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/"}
              className={({ isActive }) => "nav-tab" + (isActive ? " on" : "")}
              style={{ textDecoration: "none" }}
            >
              <span className="tab-ic">{t.icon}</span>
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="spacer" />
        <span className="badge"><span className="dot" />数据与 Key 仅存本机浏览器</span>
        {privateMode && (
          <button className="btn-ghost" onClick={() => void logout()} title="退出登录" style={{ padding: "5px 13px", fontSize: 12 }}>
            退出
          </button>
        )}
      </header>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Outlet />
      </div>
    </div>
  );
}
