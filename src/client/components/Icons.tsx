import type { FileType } from "../../shared/types";

type P = { size?: number; strokeWidth?: number | string };
const S = ({ size = 14, strokeWidth = 2, children }: P & { strokeWidth?: number | string; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export const I = {
  Logo: () => (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" /><path d="M12 12.5 21 7M12 12.5 3 7M12 12.5V22" />
    </svg>
  ),
  Plus: ({ size }: P) => <S size={size}><path d="M12 5v14M5 12h14" /></S>,
  File: ({ size }: P) => <S size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /></S>,
  FilePdf: ({ size }: P) => <S size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /><path d="M9 15h6M9 11h2" /></S>,
  FileDocx: ({ size }: P) => <S size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6" /></S>,
  FileTxt: ({ size }: P) => <S size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /><path d="M9 14h6M9 18h4" /></S>,
  Chat: ({ size }: P) => <S size={size}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></S>,
  Search: ({ size }: P) => <S size={size}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></S>,
  Settings: ({ size }: P) => <S size={size}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></S>,
  Send: ({ size }: P) => <S size={size} strokeWidth="2.4"><path d="m5 12 14-7-4.5 14-3-5.5L5 12Z" /></S>,
  Upload: ({ size }: P) => <S size={size}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></S>,
  Link: ({ size }: P) => <S size={size}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></S>,
  Eye: ({ size }: P) => <S size={size}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></S>,
  Trash: ({ size }: P) => <S size={size}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></S>,
  Refresh: ({ size }: P) => <S size={size}><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></S>,
  Copy: ({ size }: P) => <S size={size}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></S>,
  Regenerate: ({ size }: P) => <S size={size}><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></S>,
  Swap: ({ size }: P) => <S size={size}><path d="M4 17l6-6-6-6M12 19h8" /></S>,
  X: ({ size }: P) => <S size={size}><path d="M18 6 6 18M6 6l12 12" /></S>,
  Check: ({ size }: P) => <S size={size} strokeWidth="2.4"><path d="M20 6 9 17l-5-5" /></S>,
  Alert: ({ size }: P) => <S size={size}><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></S>,
  Lock: ({ size }: P) => <S size={size}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></S>,
  Globe: ({ size }: P) => <S size={size}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" /></S>,
  Chip: ({ size }: P) => <S size={size}><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="4" /></S>,
  Key: ({ size }: P) => <S size={size}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></S>,
  User: ({ size }: P) => <S size={size} strokeWidth="2.2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></S>,
  DocGrid: ({ size }: P) => <S size={size}><path d="M4 6h16M4 12h16M4 18h10" /></S>,
  Shield: ({ size }: P) => <S size={size}><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" /></S>,
  Vector: ({ size }: P) => <S size={size}><path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" /><path d="M12 12.5 21 7M12 12.5 3 7M12 12.5V22" /></S>,
  Filter: ({ size }: P) => <S size={size}><path d="M4 6h16M7 12h10M10 18h4" /></S>,
  Clock: ({ size }: P) => <S size={size}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>,
  Pages: ({ size }: P) => <S size={size}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></S>,
  Layers: ({ size }: P) => <S size={size}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></S>,
};

export function FileIcon({ type, size = 13 }: { type: FileType; size?: number }) {
  if (type === "pdf") return <I.FilePdf size={size} />;
  if (type === "docx") return <I.FileDocx size={size} />;
  return <I.FileTxt size={size} />;
}
