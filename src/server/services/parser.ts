import { extractText } from "unpdf";
import mammoth from "mammoth";
import type { Chunk } from "./chunker";
import { chunkText, chunkPages } from "./chunker";

export interface ParsedDoc {
  chunks: Chunk[];
  pageCount?: number;
}

export async function parseFile(buf: ArrayBuffer, type: string): Promise<ParsedDoc> {
  if (type === "pdf") return parsePdf(buf);
  if (type === "docx") return parseDocx(buf);
  if (type === "txt") return parseTxt(buf);
  throw new Error("不支持的文件类型");
}

async function parsePdf(buf: ArrayBuffer): Promise<ParsedDoc> {
  // unpdf/pdf.js 在解析时会把传入的 Uint8Array 的底层 ArrayBuffer 通过
  // structuredClone + transfer 转移（detach，见 pdf.js LoopbackPort.postMessage），
  // 直接传调用方持有的 buf 会把它的 byteLength 置为 0，
  // 导致之后再次使用同一 buf（如上传后留存原文件）抛
  // "Cannot perform Construct on a detached ArrayBuffer"。
  // 因此这里始终解析一份独立副本，调用方的 buffer 不受影响。
  const pdfData = new Uint8Array(buf.slice(0));
  try {
    const { totalPages, text } = await extractText(pdfData);
    const pages = (Array.isArray(text) ? text : [text]) as string[];
    const all = pages.join("\n\n");
    if (!all.trim()) {
      throw new Error("无法提取文本：该 PDF 可能为纯扫描图片（无文本层），请使用带文本层或 OCR 后的版本");
    }
    return { chunks: chunkPages(pages), pageCount: totalPages };
  } catch (e: unknown) {
    if (e instanceof Error) throw e;
    throw new Error("PDF 解析失败");
  }
}

async function parseDocx(buf: ArrayBuffer): Promise<ParsedDoc> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  const text = result.value.trim();
  if (!text) throw new Error("DOCX 中未提取到文本");
  return { chunks: chunkText(text) };
}

async function parseTxt(buf: ArrayBuffer): Promise<ParsedDoc> {
  const text = new TextDecoder("utf-8").decode(buf).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("TXT 为空");
  return { chunks: chunkText(text) };
}
