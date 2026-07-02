import { GOOGLE_DOC_MIME, type DriveFile } from "@/lib/drive/client";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";

/** Extract plain text from a downloaded corpus file, by type. */
export async function parseFile(file: DriveFile, buffer: Buffer): Promise<string> {
  const name = file.name.toLowerCase();

  if (file.mimeType === GOOGLE_DOC_MIME) return buffer.toString("utf8"); // exported to text
  if (file.mimeType === PDF_MIME || name.endsWith(".pdf")) return parsePdf(buffer);
  if (file.mimeType === DOCX_MIME || name.endsWith(".docx")) return parseDocx(buffer);
  // Markdown, text, and anything else text-like.
  return buffer.toString("utf8");
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const mod = await import("pdf-parse");
  const pdf = (mod as unknown as { default?: typeof import("pdf-parse") }).default ?? mod;
  const data = await (pdf as (b: Buffer) => Promise<{ text: string }>)(buffer);
  return data.text;
}
