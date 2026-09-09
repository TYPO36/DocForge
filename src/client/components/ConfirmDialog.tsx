import { useEffect, useRef } from "react";
import { I } from "./Icons";

interface Props {
  title: string;
  children?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 默认危险操作（红色确认按钮 + 警示图标）；false 走主题蓝 */
  danger?: boolean;
  /** 确认动作进行中：禁用两个按钮，遮罩点击 / Esc 不再关闭，避免重复触发危险操作 */
  busy?: boolean;
  busyText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认弹框（替代原生 window.confirm）：
 * 居中卡片 + 图标徽章 + 说明文案 + 取消/确认按钮。
 * 支持 Esc / 点击遮罩取消；打开时焦点落在「取消」上，防止误触危险操作。
 */
export function ConfirmDialog({
  title,
  children,
  confirmText = "确认",
  cancelText = "取消",
  danger = true,
  busy = false,
  busyText = "处理中…",
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    cancelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div className={"dlg-mask" + (busy ? " busy" : "")} onClick={() => { if (!busy) onCancel(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className={"dlg-seal" + (danger ? "" : " ok")}>
          {danger ? <I.Trash size={20} /> : <I.Alert size={20} />}
        </div>
        <h3 className="dlg-title">{title}</h3>
        <div className="dlg-body">{children}</div>
        <div className="dlg-actions">
          <button type="button" ref={cancelRef} className="btn-ghost" disabled={busy} onClick={onCancel}>{cancelText}</button>
          <button type="button" className={danger ? "btn-danger" : "btn-primary"} disabled={busy} onClick={onConfirm}>
            {busy ? busyText : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
