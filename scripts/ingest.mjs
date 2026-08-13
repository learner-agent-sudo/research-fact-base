#!/usr/bin/env node
/**
 * Standalone corpus ingestion — runs OUTSIDE the website (locally or in GitHub
 * Actions). Reads the designated Google Drive folder (recursively), extracts
 * text, chunks, embeds with Gemini (free tier, with backoff), and writes vectors
 * to Supabase. It can run for hours and never touches Vercel.
 *
 * Env required:
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *   GEMINI_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GDRIVE_CORPUS_FOLDER_ID
 * Optional: GEMINI_EMBEDDING_MODEL, EMBEDDING_DIM, EMBED_BATCH,
 *   CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS, MAX_FILE_MB
 *
 * Run:  npm run ingest
 */
import { createClient } from "@supabase/supabase-js";
import { JWT } from "google-auth-library";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const FOLDER_ID = process.env.GDRIVE_CORPUS_FOLDER_ID;

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBED_DIM = Number(process.env.EMBEDDING_DIM || 1024);
const EMBED_BATCH = Number(process.env.EMBED_BATCH || 16);
const CHUNK_TARGET = Number(process.env.CHUNK_TARGET_CHARS || 2400);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP_CHARS || 300);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 25);

function requireEnv(name, val) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}
requireEnv("SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
requireEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
requireEnv("GEMINI_API_KEY", GEMINI_API_KEY);
requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON", SA_JSON);
requireEnv("GDRIVE_CORPUS_FOLDER_ID", FOLDER_ID);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const sa = JSON.parse(SA_JSON);
const jwt = new JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
// Google access tokens expire after ~1h. A full ingest runs much longer than
// that, so cache the token and re-authorize before it lapses — otherwise every
// download past the one-hour mark fails with HTTP 401.
let tokenCache = { value: null, expiresAt: 0 };
async function driveToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  const creds = await jwt.authorize();
  if (!creds.access_token) throw new Error("Failed to get Google access token");
  // Refresh 5 minutes early rather than racing the expiry.
  const expiry = creds.expiry_date ? creds.expiry_date - 5 * 60_000 : now + 50 * 60_000;
  tokenCache = { value: creds.access_token, expiresAt: expiry };
  return tokenCache.value;
}

const MIME = {
  GDOC: "application/vnd.google-apps.document",
  FOLDER: "application/vnd.google-apps.folder",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PDF: "application/pdf",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listFolder(folderId, token) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Drive list ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// Recurse through subfolders so nested/messy structures are all covered.
async function listCorpusFiles(rootId) {
  const out = [];
  const stack = [rootId];
  const seen = new Set();
  while (stack.length) {
    const fid = stack.pop();
    if (seen.has(fid)) continue;
    seen.add(fid);
    const items = await listFolder(fid, await driveToken());
    for (const it of items) {
      if (it.mimeType === MIME.FOLDER) stack.push(it.id);
      else out.push(it);
    }
  }
  return out;
}

function isSupported(file) {
  const name = (file.name || "").toLowerCase();
  if (file.mimeType === MIME.GDOC || file.mimeType === MIME.PDF || file.mimeType === MIME.DOCX) return true;
  if ((file.mimeType || "").startsWith("text/")) return true;
  return /\.(md|markdown|txt|pdf|docx)$/.test(name);
}

async function download(file, token) {
  const url =
    file.mimeType === MIME.GDOC
      ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain&supportsAllDrives=true`
      : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Token lapsed mid-run: force a refresh and retry once.
    tokenCache = { value: null, expiresAt: 0 };
    res = await fetch(url, { headers: { Authorization: `Bearer ${await driveToken()}` } });
  }
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function parse(file, buf) {
  const name = (file.name || "").toLowerCase();
  if (file.mimeType === MIME.GDOC) return buf.toString("utf8");
  if (file.mimeType === MIME.PDF || name.endsWith(".pdf")) {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = mod.default ?? mod;
    const data = await pdfParse(buf);
    return data.text || "";
  }
  if (file.mimeType === MIME.DOCX || name.endsWith(".docx")) {
    const mod = await import("mammoth");
    const mammoth = mod.default ?? mod;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value || "";
  }
  return buf.toString("utf8");
}

function chunkText(text) {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
  };
  for (const raw of paras) {
    const p = raw.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > CHUNK_TARGET) {
      flush();
      cur = cur.slice(Math.max(0, cur.length - CHUNK_OVERLAP)) + "\n\n" + p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
    while (cur.length > CHUNK_TARGET * 1.5) {
      chunks.push(cur.slice(0, CHUNK_TARGET).trim());
      cur = cur.slice(CHUNK_TARGET - CHUNK_OVERLAP);
    }
  }
  flush();
  return chunks;
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n && Number.isFinite(n) ? v.map((x) => x / n) : v;
}

async function embedBatch(texts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: t }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBED_DIM,
        })),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.embeddings || []).map((e) => normalize(e.values));
    }
    const status = res.status;
    const body = await res.text().catch(() => "");
    if (status === 429 || status >= 500) {
      attempt++;
      const wait = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5));
      console.log(`  embed HTTP ${status} — backing off ${Math.round(wait / 1000)}s (attempt ${attempt})…`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Gemini embed ${status}: ${body.slice(0, 200)}`);
  }
}

const toVec = (v) => `[${v.join(",")}]`;

async function main() {
  console.log(`Listing Drive folder ${FOLDER_ID} (recursive)…`);
  const all = await listCorpusFiles(FOLDER_ID);
  const files = all.filter(isSupported);
  console.log(`Found ${all.length} items; ${files.length} supported, ${all.length - files.length} unsupported type.`);

  const { data: existing } = await supabase
    .from("documents")
    .select("id,drive_file_id,drive_modified_at,status")
    .eq("source", "gdrive");
  const byId = new Map((existing || []).map((d) => [d.drive_file_id, d]));
  const seen = new Set();
  const report = { loaded: [], unchanged: [], skipped: [], errored: [] };

  for (const f of files) {
    seen.add(f.id);
    try {
      const prev = byId.get(f.id);
      if (prev && prev.drive_modified_at === f.modifiedTime && prev.status === "ready") {
        report.unchanged.push(f.name);
        continue;
      }
      const sizeMB = f.size ? Number(f.size) / 1e6 : 0;
      if (sizeMB > MAX_FILE_MB) {
        report.skipped.push(`${f.name} (too large: ${sizeMB.toFixed(1)}MB > ${MAX_FILE_MB}MB)`);
        continue;
      }

      let docId = prev?.id;
      if (docId) {
        await supabase
          .from("documents")
          .update({ title: f.name, mime_type: f.mimeType, drive_modified_at: f.modifiedTime, status: "ingesting" })
          .eq("id", docId);
        await supabase.from("chunks").delete().eq("document_id", docId);
      } else {
        const { data, error } = await supabase
          .from("documents")
          .insert({
            source: "gdrive",
            drive_file_id: f.id,
            title: f.name,
            mime_type: f.mimeType,
            drive_modified_at: f.modifiedTime,
            status: "ingesting",
          })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        docId = data.id;
      }

      // Fetch per file so a long run always uses a live (auto-refreshed) token.
      const buf = await download(f, await driveToken());
      const text = await parse(f, buf);
      const chunks = chunkText(text);

      if (chunks.length === 0) {
        await supabase.from("documents").update({ status: "error" }).eq("id", docId);
        report.skipped.push(`${f.name} (no extractable text — likely a scanned PDF needing OCR)`);
        continue;
      }

      console.log(`Embedding "${f.name}" — ${chunks.length} chunks…`);
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const embs = await embedBatch(batch);
        const rows = batch.map((c, j) => ({
          document_id: docId,
          chunk_index: i + j,
          content: c,
          token_count: Math.ceil(c.length / 4),
          embedding: toVec(embs[j]),
        }));
        const { error } = await supabase.from("chunks").insert(rows);
        if (error) throw new Error(error.message);
      }
      await supabase.from("documents").update({ status: "ready" }).eq("id", docId);
      report.loaded.push(`${f.name} (${chunks.length} chunks)`);
    } catch (e) {
      const msg = e?.message || String(e);
      report.errored.push(`${f.name}: ${msg}`);
      console.log(`  ERROR "${f.name}": ${msg}`);
    }
  }

  // Remove documents whose Drive file has disappeared.
  for (const [fid, doc] of byId) {
    if (fid && !seen.has(fid)) {
      await supabase.from("documents").delete().eq("id", doc.id);
      report.skipped.push(`(removed missing file ${fid})`);
    }
  }

  console.log("\n===================== INGEST REPORT =====================");
  console.log(`Loaded (${report.loaded.length}):`);
  report.loaded.forEach((x) => console.log(`  ✓ ${x}`));
  console.log(`Unchanged: ${report.unchanged.length}`);
  console.log(`Skipped (${report.skipped.length}):`);
  report.skipped.forEach((x) => console.log(`  – ${x}`));
  console.log(`Errored (${report.errored.length}):`);
  report.errored.forEach((x) => console.log(`  ✗ ${x}`));

  const { count } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .not("embedding", "is", null);
  console.log(`\nTotal embedded chunks now in the database: ${count}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
