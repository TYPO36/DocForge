import { useEffect, useMemo, useState } from "react";
import { I } from "./Icons";
import type { DocumentMeta } from "../../shared/types";
import { fetchDocText, fileUrl } from "../lib/api";

interface Props {
  doc: DocumentMeta;
  highlight?: string; // 被引用的片段（可能跨页合并，含"（第 N 页）"分页头）
  page?: number | null;
  onClose: () => void;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 引用片段里的 HTML 特殊字符做转义，避免污染 innerHTML
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ViewerModal({ doc, highlight, page, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // PDF + 引用高亮时默认"引用定位"（基于提取文本可高亮），可切回"原始 PDF"
  const [tab, setTab] = useState<"text" | "pdf">("text");

  const pdfWithCite = doc.type === "pdf" && !!highlight;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 需要文本视图才拉取（docx/txt 一直用文本；PDF 仅当带引用高亮且处于"引用定位"标签）
  const needText = doc.type !== "pdf" || (pdfWithCite && tab === "text");
  useEffect(() => {
    if (!needText) return;
    setText(null);
    setErr("");
    fetchDocText(doc.id)
      .then((d) => setText(d.text))
      .catch((e) => setErr((e as Error).message));
  }, [doc.id, needText]);

  // 引用片段可能含多个"（第 N 页）"分页头（跨页合并）；拆成多段后任一段命中即高亮
  const hlRe = useMemo(() => {
    if (!highlight) return undefined;
    const segs = highlight
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^（第 \d+ 页）/, "").trim())
      .filter((s) => s.length > 0);
    if (segs.length === 0) return undefined;
    try { return new RegExp(segs.map(escRe).join("|"), "gi"); } catch { return undefined; }
  }, [highlight]);

  const highlightHtml = (t: string) => {
    if (!hlRe) return t;
    return t.replace(hlRe, (m0) => `<mark class="hl">${escHtml(m0)}</mark>`);
  };

  const showPdfIframe = doc.type === "pdf" && (!pdfWithCite || tab === "pdf");

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="file-icon" style={{ width: 30, height: 30 }}>{doc.type === "pdf" ? <I.FilePdf /> : doc.type === "docx" ? <I.FileDocx /> : <I.FileTxt />}</span>
          <span className="name">{doc.name}{page ? ` · 第 ${page} 页` : ""}</span>
          <button className="icon-btn" onClick={onClose}><I.X /></button>
        </div>

        {pdfWithCite && (
          <div className="view-tabs">
            <button type="button" className={tab === "text" ? "on" : ""} onClick={() => setTab("text")}>引用定位（文本高亮）</button>
            <button type="button" className={tab === "pdf" ? "on" : ""} onClick={() => setTab("pdf")}>原始 PDF</button>
          </div>
        )}

        <div className="modal-body">
          {showPdfIframe ? (
            <iframe title="pdf" src={fileUrl(doc.id) + (page ? `#page=${page}` : "")} style={{ width: "100%", height: "100%", border: "none" }} />
          ) : err ? (
            <div className="err-msg" style={{ margin: 20 }}><I.Alert />{err}</div>
          ) : text === null ? (
            <div className="empty"><I.Clock /><p>正在加载原文…</p></div>
          ) : text.length === 0 ? (
            <div className="empty"><I.Alert /><p>该文档未提取到文本，无法高亮；请切换到「原始 PDF」查看。</p></div>
          ) : (
            <pre dangerouslySetInnerHTML={{ __html: highlightHtml(text) }} />
          )}
        </div>
      </div>
    </div>
  );
}
