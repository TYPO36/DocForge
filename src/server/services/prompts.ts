import type { RetrievedChunk, RetrievedFact } from "./retrieve";

/** 知识库文档清单中的一项（仅文件名/类型/状态，不含正文） */
export interface DocInfo { name: string; type: string; status?: string; }

const MAX_LISTED_DOCS = 100;
const STATUS_TEXT: Record<string, string> = { ready: "", processing: "（索引中）", failed: "（解析失败）" };

function buildInventory(docs: DocInfo[]): string {
  if (docs.length === 0) return "（当前还没有上传任何文档）";
  const shown = docs.slice(0, MAX_LISTED_DOCS);
  const lines = shown.map((d, i) => {
    const st = d.status ? (STATUS_TEXT[d.status] ?? "") : "";
    const line = (i + 1) + ". 《" + d.name + "》（" + d.type + "）" + st;
    return line.replace(/\s+$/, "");
  });
  const rest = docs.length > MAX_LISTED_DOCS ? "\n…（其余 " + (docs.length - MAX_LISTED_DOCS) + " 篇略）" : "";
  return "当前共上传 " + docs.length + " 篇文档：\n" + lines.join("\n") + rest;
}

function locOf(c: RetrievedChunk): string {
  const pages = c.pages && c.pages.length > 0 ? c.pages : c.page != null ? [c.page] : [];
  const p = pages.length > 0 ? " 第 " + pages.join("、") + " 页" : "";
  return "（" + c.docName + p + "）";
}

/** @param facts 图谱“关系事实”（可选），不给引用编号，仅用于跨文档定位引导 */
export function buildSystemPrompt(chunks: RetrievedChunk[], docs: DocInfo[] = [], facts: RetrievedFact[] = []): string {
  const ctx = chunks.length
    ? chunks.map((c, i) => "[片段 " + (i + 1) + "]" + locOf(c) + "\n" + c.text).join("\n\n")
    : "（本次没有检索到任何文档片段）";
  const factCtx = facts.length
    ? facts.map((f) => "- 《" + f.docName + "》：事实 " + f.source + " 与 " + f.target + " — " + f.description).join("\n")
    : "";
  const parts = [
    "你是 DocForge 文档问答助手，基于用户知识库中「已上传的文档」回答问题。上下文分为三部分：",
    "A. 文档清单：当前知识库中已上传的所有文档（文件名真实可信）；",
    "B. 检索片段：针对当前问题检索到的片段，编号 [片段 1]、[片段 2]…，与回答下方的引用来源卡片 1、2…一一对应；",
    "C. 关系事实（图谱，可选出现）：文档间抽出的实体关系事实，标注《文档名》，用于定位哪些文档涉及什么，无页码。",
    "", "【文档清单】", buildInventory(docs), "", "【检索片段】", ctx,
    factCtx ? "\n【关系事实】\n" + factCtx : "",
    "", "【规则】",
    "1. 先判断问题类型，再决定依据哪部分回答：",
    "   - 若问题在询问“已上传文档/文件本身”…（如“现在一共有几个订阅报告”）：依据【文档清单】按文件名归类统计并列出文件名，直接作答。",
    "   - 若问题在询问文档内容——依据【检索片段】回答；仅当片段中确实没有相关内容时，才回答“文档中没有找到相关信息”，不要编造。",
    "   - 跨文档对比/全局归纳类问题：可先用【关系事实】判断涉及哪些文档，但具体数值、条款、结论必须落到【检索片段】原文证据；某文档只有事实而无对应片段时，可据事实简述并标注《文档名》，不得虚构细节。",
    "2. 引用：引用片段内容处用 [序号] 标注（如 [1]），序号与检索片段编号/引用来源卡片一一对应；仅按文档清单统计时可不标注。",
    "3. 若文档清单为空，提示用户先上传文档。",
    "4. 回答用中文，简洁清晰，可适当分点；不要提及“片段/文档编号/关系事实”以外的内部机制。",
  ];
  return parts.join("\n");
}

export function buildMessages(system: string, history: { role: string; content: string }[], question: string) {
  const messages: { role: string; content: string }[] = [{ role: "system", content: system }];
  const tail = history.slice(-6);
  for (const m of tail) messages.push({ role: m.role, content: m.content.slice(0, 4000) });
  messages.push({ role: "user", content: question });
  return messages;
}