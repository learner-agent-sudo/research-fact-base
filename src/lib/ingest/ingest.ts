import { downloadFile, driveConfigured, listCorpusFiles, type DriveFile } from "@/lib/drive/client";
import { embedDocuments, embeddingsConfigured, toVectorLiteral } from "@/lib/embeddings/voyage";
import { supabaseAdmin } from "@/lib/supabase/server";
import { chunkText } from "./chunk";
import { parseFile } from "./parse";

export interface IngestResult {
  file: string;
  status: "materialized" | "skipped" | "error" | "deleted";
  chunks?: number;
  error?: string;
}

export interface SyncResult {
  done: boolean;
  remaining: number; // chunks still needing an embedding
  results: IngestResult[];
}

// Serverless-friendly budgets. Each call returns well under Vercel's 60s cap;
// the admin page loops until `done`. Progress is committed continuously, so a
// timeout (or a new call) simply resumes where the last left off.
const TIME_BUDGET_MS = 45_000;
const MATERIALIZE_CUTOFF_MS = 15_000; // don't START parsing a new file after this
const EMBED_BATCH = 32;
const INSERT_BATCH = 200;

/**
 * Resumable Google Drive → vector-store sync. A document moves through:
 *   pending    → row exists, not yet parsed
 *   ingesting  → chunks inserted (content only), embeddings in progress
 *   ready      → every chunk embedded
 * Retrieval ignores chunks whose embedding is still NULL, so partial progress
 * is safe to leave between calls.
 */
export async function syncCorpus(): Promise<SyncResult> {
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

  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const results: IngestResult[] = [];

  const files = await listCorpusFiles();
  const fileById = new Map(files.map((f) => [f.id, f]));

  // 1. Reconcile document rows with Drive (new / changed / deleted).
  const { data: existing } = await supabase
    .from("documents")
    .select("id, drive_file_id, drive_modified_at, status")
    .eq("source", "gdrive");
  const docs = new Map<string, { id: string; status: string; modified: string }>(
    (existing || []).map((d) => [
      d.drive_file_id as string,
      { id: d.id as string, status: d.status as string, modified: d.drive_modified_at as string },
    ]),
  );
  const seen = new Set<string>();

  for (const f of files) {
    seen.add(f.id);
    const cur = docs.get(f.id);
    if (!cur) {
      const { data } = await supabase
        .from("documents")
        .insert({
          source: "gdrive",
          drive_file_id: f.id,
          title: f.name,
          mime_type: f.mimeType,
          drive_modified_at: f.modifiedTime,
          status: "pending",
        })
        .select("id")
        .single();
      if (data) docs.set(f.id, { id: data.id as string, status: "pending", modified: f.modifiedTime });
    } else if (cur.modified !== f.modifiedTime) {
      await supabase.from("chunks").delete().eq("document_id", cur.id);
      await supabase
        .from("documents")
        .update({ title: f.name, mime_type: f.mimeType, drive_modified_at: f.modifiedTime, status: "pending" })
        .eq("id", cur.id);
      cur.status = "pending";
      cur.modified = f.modifiedTime;
    }
  }

  // Delete documents whose Drive file disappeared.
  for (const [fid, doc] of docs) {
    if (fid && !seen.has(fid)) {
      await supabase.from("documents").delete().eq("id", doc.id);
      results.push({ file: `(removed ${fid})`, status: "deleted" });
      docs.delete(fid);
    }
  }

  // 2. Materialize pending docs (parse + chunk + insert content rows). One file
  //    at a time, and only early in the budget so a slow parse can't overrun.
  for (const [fid, doc] of docs) {
    if (doc.status !== "pending") continue;
    if (elapsed() > MATERIALIZE_CUTOFF_MS) break;
    const f = fileById.get(fid);
    if (!f) continue;
    try {
      results.push(await materialize(supabase, f, doc.id));
      doc.status = "ingesting";
    } catch (e) {
      await supabase.from("documents").update({ status: "error" }).eq("id", doc.id);
      results.push({ file: f.name, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3. Embed pending chunks (embedding IS NULL) until the time budget is spent.
  while (elapsed() < TIME_BUDGET_MS) {
    const { data: pending } = await supabase
      .from("chunks")
      .select("id, content")
      .is("embedding", null)
      .limit(EMBED_BATCH);
    if (!pending || pending.length === 0) break;

    const embeddings = await embedDocuments(pending.map((p) => p.content as string));
    await Promise.all(
      pending.map((p, i) =>
        supabase.from("chunks").update({ embedding: toVectorLiteral(embeddings[i]) }).eq("id", p.id),
      ),
    );
  }

  // 4. Promote fully-embedded docs to 'ready'.
  const { data: ingesting } = await supabase.from("documents").select("id").eq("status", "ingesting");
  for (const d of ingesting || []) {
    const { count } = await supabase
      .from("chunks")
      .select("id", { count: "exact", head: true })
      .eq("document_id", d.id)
      .is("embedding", null);
    if ((count ?? 0) === 0) {
      await supabase.from("documents").update({ status: "ready" }).eq("id", d.id);
    }
  }

  // 5. Compute progress.
  const { count: remaining } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  const { count: pendingDocs } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return {
    done: (remaining ?? 0) === 0 && (pendingDocs ?? 0) === 0,
    remaining: remaining ?? 0,
    results,
  };
}

async function materialize(
  supabase: NonNullable<ReturnType<typeof supabaseAdmin>>,
  file: DriveFile,
  docId: string,
): Promise<IngestResult> {
  const buffer = await downloadFile(file);
  const text = await parseFile(file, buffer);
  const chunks = chunkText(text);

  await supabase.from("chunks").delete().eq("document_id", docId);

  const rows = chunks.map((c) => ({
    document_id: docId,
    chunk_index: c.index,
    content: c.content,
    token_count: c.tokenEstimate,
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await supabase.from("chunks").insert(rows.slice(i, i + INSERT_BATCH));
    if (error) throw new Error(`insert chunks failed: ${error.message}`);
  }

  await supabase
    .from("documents")
    .update({ status: chunks.length ? "ingesting" : "ready" })
    .eq("id", docId);

  return { file: file.name, status: "materialized", chunks: chunks.length };
}
