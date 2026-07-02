import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadFile, driveConfigured, listCorpusFiles, type DriveFile } from "@/lib/drive/client";
import { embedDocuments, embeddingsConfigured, toVectorLiteral } from "@/lib/embeddings/voyage";
import { supabaseAdmin } from "@/lib/supabase/server";
import { chunkText } from "./chunk";
import { parseFile } from "./parse";

export interface IngestResult {
  file: string;
  status: "ingested" | "skipped" | "error" | "deleted";
  chunks?: number;
  error?: string;
}

const INSERT_BATCH = 100;

/**
 * Sync the designated Drive folder into the vector store:
 *   list → diff by modifiedTime → download → parse → chunk → embed → upsert,
 * and delete rows whose Drive file has disappeared.
 */
export async function syncCorpus(): Promise<{ results: IngestResult[] }> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    throw new Error("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }
  if (!driveConfigured()) {
    throw new Error("Google Drive is not configured (GOOGLE_SERVICE_ACCOUNT_JSON / GDRIVE_CORPUS_FOLDER_ID).");
  }
  if (!embeddingsConfigured()) {
    throw new Error("Embeddings are not configured (VOYAGE_API_KEY).");
  }

  const files = await listCorpusFiles();
  const results: IngestResult[] = [];

  const { data: existingDocs } = await supabase
    .from("documents")
    .select("id, drive_file_id, drive_modified_at")
    .eq("source", "gdrive");
  const existingByFileId = new Map(
    (existingDocs || []).map((d) => [d.drive_file_id as string, d]),
  );
  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file.id);
    try {
      const existing = existingByFileId.get(file.id);
      if (existing && existing.drive_modified_at === file.modifiedTime) {
        results.push({ file: file.name, status: "skipped" });
        continue;
      }
      results.push(await ingestOne(supabase, file, existing?.id as string | undefined));
    } catch (e) {
      results.push({ file: file.name, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Remove documents whose Drive file no longer exists.
  for (const [fileId, doc] of existingByFileId) {
    if (fileId && !seen.has(fileId)) {
      await supabase.from("documents").delete().eq("id", doc.id);
      results.push({ file: `(removed ${fileId})`, status: "deleted" });
    }
  }

  return { results };
}

async function ingestOne(
  supabase: SupabaseClient,
  file: DriveFile,
  existingId: string | undefined,
): Promise<IngestResult> {
  let docId: string;

  if (existingId) {
    docId = existingId;
    await supabase
      .from("documents")
      .update({
        title: file.name,
        mime_type: file.mimeType,
        drive_modified_at: file.modifiedTime,
        status: "ingesting",
      })
      .eq("id", docId);
    await supabase.from("chunks").delete().eq("document_id", docId);
  } else {
    const { data, error } = await supabase
      .from("documents")
      .insert({
        source: "gdrive",
        drive_file_id: file.id,
        title: file.name,
        mime_type: file.mimeType,
        drive_modified_at: file.modifiedTime,
        status: "ingesting",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert document failed: ${error?.message}`);
    docId = data.id as string;
  }

  const buffer = await downloadFile(file);
  const text = await parseFile(file, buffer);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    await supabase.from("documents").update({ status: "ready" }).eq("id", docId);
    return { file: file.name, status: "ingested", chunks: 0 };
  }

  const embeddings = await embedDocuments(chunks.map((c) => c.content));
  const rows = chunks.map((c, i) => ({
    document_id: docId,
    chunk_index: c.index,
    content: c.content,
    token_count: c.tokenEstimate,
    embedding: toVectorLiteral(embeddings[i]),
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + INSERT_BATCH));
    if (error) {
      await supabase.from("documents").update({ status: "error" }).eq("id", docId);
      throw new Error(`insert chunks failed: ${error.message}`);
    }
  }

  await supabase.from("documents").update({ status: "ready" }).eq("id", docId);
  return { file: file.name, status: "ingested", chunks: chunks.length };
}
