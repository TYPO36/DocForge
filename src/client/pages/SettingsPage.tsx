import { useCallback, useEffect, useRef, useState } from "react";
import { I } from "../components/Icons";
import type { AppConfig, TestResult } from "../../shared/types";
import { loadConfig, saveConfig } from "../lib/config";
import { useActionGuard } from "../lib/useActionGuard";
import { testConnection } from "../lib/api";

const SETTINGS_SECTION_IDS = {
  models: "settings-models",
  embedding: "settings-embedding",
  privacy: "settings-privacy",
  about: "settings-about",
} as const;

type SettingsSection = keyof typeof SETTINGS_SECTION_IDS;

const SETTINGS_NAV = [
  { id: "models", label: "模型配置", icon: <I.Chip /> },
  { id: "embedding", label: "向量化 Embedding", icon: <I.Vector /> },
  { id: "privacy", label: "数据与隐私", icon: <I.Shield /> },
  { id: "about", label: "关于", icon: <I.Alert /> },
] as const;

export default function SettingsPage() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadConfig());
  // 本次打开页面时,是否已从本机(localStorage)读到上次保存的 API Key
  const [storedOnLoad] = useState(() => {
    const c = loadConfig();
    return { chat: !!c.chat.apiKey, embed: !!c.embed.apiKey };
  });
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<"chat" | "embed" | null>(null);
  const [chatRes, setChatRes] = useState<TestResult | null>(null);
  const [embedRes, setEmbedRes] = useState<TestResult | null>(null);
  const [showKey, setShowKey] = useState({ chat: false, embed: false });
  const [activeSection, setActiveSection] = useState<SettingsSection>("models");

  // 按钮防抖/防重入
  const guard = useActionGuard();

  const scrollToSection = (section: SettingsSection) => {
    setActiveSection(section);
    document.getElementById(SETTINGS_SECTION_IDS[section])?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const savedTimer = useRef<number | null>(null);
  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 2600);
  }, []);

  // 自动保存到本机：配置（含 API Key）变化后 400ms 自动写入 localStorage。
  // 保存过一次之后，刷新页面或下次再打开都会自动读取填入，无需重新输入。
  const prevCfg = useRef(JSON.stringify(cfg));
  useEffect(() => {
    const cur = JSON.stringify(cfg);
    if (cur === prevCfg.current) return; // 初次挂载/无变化时不触发
    prevCfg.current = cur;
    const t = window.setTimeout(() => { saveConfig(cfg); flashSaved(); }, 400);
    return () => window.clearTimeout(t);
  }, [cfg, flashSaved]);

  const patchChat = (p: Partial<AppConfig["chat"]>) => setCfg((c) => ({ ...c, chat: { ...c.chat, ...p } }));
  const patchEmbed = (p: Partial<AppConfig["embed"]>) => setCfg((c) => ({ ...c, embed: { ...c.embed, ...p } }));
  const patchIndex = (p: Partial<AppConfig["index"]>) => setCfg((c) => ({ ...c, index: { ...c.index, ...p } }));
  const patchRerank = (p: Partial<AppConfig["rerank"]>) => setCfg((c) => ({ ...c, rerank: { ...c.rerank, ...p } }));
  const patchOptions = (p: Partial<AppConfig["options"]>) => setCfg((c) => ({ ...c, options: { ...c.options, ...p } }));

  const save = () => {
    saveConfig(cfg);
    flashSaved();
  };  const runTest = async (kind: "chat" | "embed") => {
    setTesting(kind);
    try {
      const r = await testConnection(kind, cfg.chat, cfg.embed);
      if (kind === "chat") setChatRes(r); else setEmbedRes(r);
    } catch (e) {
      const r: TestResult = { ok: false, kind, message: (e as Error).message };
      if (kind === "chat") setChatRes(r); else setEmbedRes(r);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="body-settings">
      <aside className="lnav" aria-label="设置导航">
        <h3>配置</h3>
        {SETTINGS_NAV.map((item) => {
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={"lnav-item" + (isActive ? " on" : "")}
              aria-current={isActive ? "true" : undefined}
              onClick={() => scrollToSection(item.id)}
            >
              {item.icon}{item.label}
            </button>
          );
        })}
      </aside>

      <div className="main-settings">
        {/* API Key 本地保存提示 */}
        {storedOnLoad.chat || storedOnLoad.embed ? (
          <div className="keynote"><I.Check size={13} /><span>已自动读取<b>本机保存的 API Key</b>，无需重新输入。Key 仅保存在你的浏览器 localStorage，只在发起请求时随请求头传给服务商，不会上传或存储到服务器。</span></div>
        ) : (
          <div className="keynote"><I.Key size={13} /><span>API Key <b>输入后会自动保存</b>到本机浏览器（localStorage），刷新或下次打开会自动填入，无需重新输入。提示：浏览器按“地址 + 端口”分别存储，请固定使用同一地址（如 http://localhost:8788）访问。</span></div>
        )}

        {/* Chat */}
        <div id={SETTINGS_SECTION_IDS.models} className="card settings-section">
          <div className="card-head">
            <h2><span className="ic"><I.Chip /></span>对话模型 Chat</h2>
            <span className="hint">用于回答问题 · 兼容任何 OpenAI API 服务</span>
          </div>
          <div className="field">
            <label>模型名称</label>
            <div className="input"><I.Chip /><input value={cfg.chat.model} placeholder="如 deepseek-chat / gpt-4o-mini" onChange={(e) => patchChat({ model: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>Base URL（API 地址）</label>
            <div className="input"><I.Globe /><input value={cfg.chat.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => patchChat({ baseUrl: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>API Key</label>
            <div className="input">
              <I.Key />
              <input type={showKey.chat ? "text" : "password"} value={cfg.chat.apiKey} placeholder="sk-..." onChange={(e) => patchChat({ apiKey: e.target.value })} />
              <span className="eye" onClick={() => setShowKey((s) => ({ ...s, chat: !s.chat }))}><I.Eye /></span>
            </div>
            <p className="key-hint"><I.Lock size={11} />仅保存在本机浏览器 · 修改后自动保存{storedOnLoad.chat ? " · 已读取上次保存的 Key" : ""}</p>
          </div>
          <div className="row">
            <div className="field">
              <label>Temperature 温度</label>
              <div className="range">
                <input type="range" min={0} max={2} step={0.1} value={cfg.chat.temperature} onChange={(e) => patchChat({ temperature: Number(e.target.value) })} />
                <span className="val">{cfg.chat.temperature.toFixed(1)}</span>
              </div>
            </div>
            <div className="field">
              <label>Max Tokens 最大输出</label>
              <div className="input"><input type="number" value={cfg.chat.maxTokens} onChange={(e) => patchChat({ maxTokens: Number(e.target.value) })} /></div>
            </div>
          </div>
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 14, margin: 0 }}>
            <div className={"toggle" + (cfg.chat.stream ? " on" : "")} onClick={() => patchChat({ stream: !cfg.chat.stream })}><span className="sw" />启用流式输出（SSE）</div>
            <div className="spacer" />
            <button className="btn-ghost" disabled={testing === "chat"} onClick={() => guard("test:chat", runTest, "chat")}><I.Refresh />{testing === "chat" ? "测试中…" : "连接测试"}</button>
          </div>
          {chatRes && (
            <div className={"test-result" + (chatRes.ok ? "" : " err")}>
              {chatRes.ok ? <I.Check /> : <I.Alert />}{chatRes.message}
            </div>
          )}
        </div>

        {/* Embedding */}
        <div id={SETTINGS_SECTION_IDS.embedding} className="card settings-section">
          <div className="card-head">
            <h2><span className="ic violet"><I.Vector /></span>向量化模型 Embedding</h2>
            <span className="hint">用于文档分块向量化与语义检索</span>
          </div>
          <div className="field">
            <label>模型名称</label>
            <div className="input"><I.Chip /><input value={cfg.embed.model} placeholder="如 BAAI/bge-m3 / nomic-embed-text" onChange={(e) => patchEmbed({ model: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>Base URL（API 地址）</label>
            <div className="input"><I.Globe /><input value={cfg.embed.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => patchEmbed({ baseUrl: e.target.value })} /></div>
          </div>
          <div className="field">
            <label>API Key</label>
            <div className="input">
              <I.Key />
              <input type={showKey.embed ? "text" : "password"} value={cfg.embed.apiKey} placeholder="sk-..." onChange={(e) => patchEmbed({ apiKey: e.target.value })} />
              <span className="eye" onClick={() => setShowKey((s) => ({ ...s, embed: !s.embed }))}><I.Eye /></span>
            </div>
            <p className="key-hint"><I.Lock size={11} />仅保存在本机浏览器 · 修改后自动保存{storedOnLoad.embed ? " · 已读取上次保存的 Key" : ""}</p>
          </div>
          <div className="row" style={{ marginBottom: 0 }}>
            <div className="field">
              <label>向量维度（自动检测，可留默认）</label>
              <div className="input"><input type="number" value={cfg.embed.dimension || ""} placeholder="1024" onChange={(e) => patchEmbed({ dimension: Number(e.target.value) || 0 })} /></div>
            </div>
            <div className="field" style={{ display: "flex", alignItems: "flex-end", justifyContent: "flex-end" }}>
              <button className="btn-ghost" disabled={testing === "embed"} onClick={() => guard("test:embed", runTest, "embed")}><I.Refresh />{testing === "embed" ? "测试中…" : "连接测试"}</button>
            </div>
          </div>
          {embedRes && (
            <div className={"test-result" + (embedRes.ok ? "" : " err")}>
              {embedRes.ok ? <I.Check /> : <I.Alert />}{embedRes.message}
            </div>
          )}
        </div>

        {/* 检索增强 RAG v2（可选 · 全部标注开源/费用/依赖） */}
        <div className="card">
          <div className="card-head">
            <h2><span className="ic"><I.Layers /></span>检索增强 <small style={{fontWeight:400}}>（可关闭多查询、图谱与重排；基础混合检索始终启用）</small></h2>
            <span className="hint">多查询与图谱默认开启，Rerank 默认关闭 · 配置缺失自动降级</span>
          </div>

          <div className="rag-option-row">
            <div className={"toggle rag-option-toggle" + (cfg.options.rewrite ? " on" : "")} onClick={() => patchOptions({ rewrite: !cfg.options.rewrite })}><span className="sw" />多查询改写</div>
            <span className="key-hint rag-option-hint">把 1 问拆 3 视角检索，减少漏检 · 标注：<b>消耗对话模型少量 Token</b>（每次提问 ≈300~500 token，DeepSeek 约 ¥0.001）· 需填对话模型</span>
          </div>

          <div className="rag-option-row">
            <div className={"toggle rag-option-toggle" + (cfg.options.graph ? " on" : "")} onClick={() => patchOptions({ graph: !cfg.options.graph })}><span className="sw" />图谱增强（实体/关系索引与检索）</div>
            <span className="key-hint rag-option-hint">上传/重索引时抽取实体关系，提升跨文档对比与全局问答 · 标注：<b>抽取消耗对话/索引模型 Token</b>（100 页 ≈¥1~2 DeepSeek；配下方本机 Ollama 则 ¥0）；查询期零成本</span>
          </div>

          <div className="row rag-field-row rag-field-row--index">
            <div className="field">
              <label>图谱抽取模型（可选，默认用对话模型）</label>
              <div className="input"><I.Chip /><input value={cfg.index.model} placeholder="如 qwen2.5（Ollama） 或留空" onChange={(e) => patchIndex({ model: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>Base URL</label>
              <div className="input"><I.Globe /><input value={cfg.index.baseUrl} placeholder="留空=对话模型；Ollama: http://localhost:11434/v1" onChange={(e) => patchIndex({ baseUrl: e.target.value })} /></div>
            </div>
            <div className="field field--full">
              <label>API Key</label>
              <div className="input"><I.Key /><input type="password" value={cfg.index.apiKey} placeholder="留空=对话模型" onChange={(e) => patchIndex({ apiKey: e.target.value })} /></div>
            </div>
          </div>
          <p className="key-hint"><I.Lock size={11} />标注：留空 = 复用「对话模型」抽取（会消耗其 Token，本机 Ollama 全免费）。Key 仅存本机，随请求头发送。</p>

          <div className="rag-option-row rag-option-row--spaced">
            <div className={"toggle rag-option-toggle" + (cfg.rerank.enabled ? " on" : "")} onClick={() => patchRerank({ enabled: !cfg.rerank.enabled })}><span className="sw" />二次重排 Rerank</div>
            <span className="key-hint rag-option-hint">对检索结果做交叉编码精排 · 标注：<b>免费开源 bge-reranker-v2-m3</b>（硅基流动免费额度 / 本地兼容服务）；失败自动回退融合排序</span>
          </div>
          <div className="row rag-field-row">
            <div className="field">
              <label>模型名称</label>
              <div className="input"><I.Chip /><input value={cfg.rerank.model} onChange={(e) => patchRerank({ model: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>Base URL（POST /rerank 兼容）</label>
              <div className="input"><I.Globe /><input value={cfg.rerank.baseUrl} placeholder="https://api.siliconflow.cn/v1" onChange={(e) => patchRerank({ baseUrl: e.target.value })} /></div>
            </div>
            <div className="field field--full">
              <label>API Key</label>
              <div className="input"><I.Key /><input type="password" value={cfg.rerank.apiKey} placeholder="sk-..." onChange={(e) => patchRerank({ apiKey: e.target.value })} /></div>
            </div>
          </div>
        </div>

        {/* 数据与隐私 */}
        <div id={SETTINGS_SECTION_IDS.privacy} className="card settings-section">
          <div className="card-head">
            <h2><span className="ic"><I.Shield /></span>数据与隐私</h2>
            <span className="hint">本地优先 · 服务端不持久化密钥</span>
          </div>
          <div className="privacy-list">
            <p className="privacy-item"><I.Lock /><span><b>API Key</b> 仅保存在当前浏览器的 localStorage，请求时通过请求头瞬时传递，服务端不会持久化。</span></p>
            <p className="privacy-item"><I.Shield /><span><b>文档数据</b> 在 Cloudflare 部署时存储于你的专属 D1/R2；本地 / Docker 模式下全部数据留在你的设备。</span></p>
          </div>
        </div>

        {/* 关于 */}
        <div id={SETTINGS_SECTION_IDS.about} className="about-card settings-section">
          <div className="big"><I.Logo /></div>
          <div>
            <h3>DocForge · 轻量 RAG 文档问答</h3>
            <p>开源 · MIT License。提供本地、Docker 与 Cloudflare 三种部署方式，检索增强能力均可独立开关，并在配置缺失时自动回退到纯向量检索。</p>
          </div>
          <div className="ver">v0.1.0<br /><b>MIT</b></div>
        </div>

        <div className="save-bar">
          <span className="note"><I.Lock />{saved ? "已自动保存到本机浏览器（localStorage）" : "API Key 等配置自动保存在本机浏览器，刷新 / 下次打开无需重新输入，不会上传服务器"}</span>
          <button className="btn-primary" onClick={() => guard("save", save)}>{saved ? "✓ 已保存" : "保存配置"}</button>
        </div>
      </div>
    </div>
  );
}
