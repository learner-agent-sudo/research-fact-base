"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppHeader from "@/components/AppHeader";
import AuthGate from "@/components/AuthGate";
import { api, errorMessage, REPO_URL } from "@/lib/supabase";

interface Doc {
  id: string;
  title: string;
  status: string;
  drive_file_id: string | null;
}

interface Library {
  folderId?: string;
  finishedAt?: string;
  loaded?: number;
  removed?: number;
  errored?: number;
  stoppedEarly?: boolean;
}

const STATUS: Record<string, { label: string; style: string; help?: string }> = {
  ready: { label: "Ready", style: "bg-green-100 text-green-800" },
  ingesting: { label: "Loading…", style: "bg-blue-100 text-blue-800", help: "Finishes on the next load" },
  pending: { label: "Waiting", style: "bg-neutral-100 text-neutral-600", help: "Loads on the next load" },
  error: {
    label: "Couldn't read",
    style: "bg-red-100 text-red-800",
    help: "No text found — probably a scanned PDF (pictures of pages)",
  },
};

export default function DocumentsPage() {
  return <AuthGate>{() => <Documents />}</AuthGate>;
}

/** The time of day the daily load runs (09:00 UTC), in the reader's own time zone. */
function dailyLoadTime(): string {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Documents() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [passages, setPassages] = useState(0);
  const [library, setLibrary] = useState<Library>({});
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await api("/documents");
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      setDocs(data.documents ?? []);
      setPassages(data.embeddedChunks ?? 0);
      setLibrary(data.library ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = (docs ?? []).reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q));
  }, [docs, filter]);

  const folderUrl = library.folderId ? `https://drive.google.com/drive/folders/${library.folderId}` : null;
  const loaderUrl = REPO_URL ? `${REPO_URL}/actions/workflows/ingest.yml` : null;

  return (
    <div className="min-h-dvh">
      <AppHeader active="documents" />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <div>
          <h1 className="text-lg font-semibold">Your documents</h1>
          <p className="text-sm text-neutral-500">The app answers only from the documents listed here.</p>
        </div>

        <section aria-label="Summary" className="rounded-xl border border-neutral-200 bg-white p-4 text-sm">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>
              <strong>{counts.ready ?? 0}</strong> ready to search
            </span>
            {(counts.ingesting ?? 0) + (counts.pending ?? 0) > 0 && (
              <span>
                <strong>{(counts.ingesting ?? 0) + (counts.pending ?? 0)}</strong> still loading
              </span>
            )}
            {(counts.error ?? 0) > 0 && (
              <span>
                <strong>{counts.error}</strong> couldn&apos;t be read
              </span>
            )}
            <span className="text-neutral-500">{passages.toLocaleString()} searchable passages</span>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            {library.finishedAt ? (
              <>
                Last checked for new or changed files: {new Date(library.finishedAt).toLocaleString()}
                {library.loaded ? ` — ${library.loaded} added or updated` : " — no changes"}
                {library.removed ? `, ${library.removed} removed` : ""}
                {library.stoppedEarly ? " (stopped at the daily limit; continues next time)" : ""}.
              </>
            ) : (
              "New and changed files are checked for once a day."
            )}
          </p>
        </section>

        <section aria-labelledby="add-heading" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm">
          <h2 id="add-heading" className="font-semibold text-blue-800">
            How to add more sources
          </h2>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-neutral-700">
            <li>
              Put the file in the app&apos;s Google Drive folder
              {folderUrl ? (
                <>
                  {" "}
                  (
                  <a href={folderUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                    open the folder ↗
                  </a>
                  )
                </>
              ) : (
                " (the folder you chose when setting the app up)"
              )}
              . Subfolders are included too.
            </li>
            <li>
              Use a format the app can read: <strong>Word (.docx)</strong>, <strong>Google Docs</strong>,{" "}
              <strong>PDF</strong> with selectable text, <strong>Markdown (.md)</strong> or{" "}
              <strong>text (.txt)</strong>. Scanned PDFs (photos of pages) can&apos;t be read — run them through
              OCR first.
            </li>
            <li>
              Wait for the daily load, around <strong>{dailyLoadTime()}</strong> your time. New files are added
              and edited files are refreshed automatically.
              {loaderUrl && (
                <>
                  {" "}
                  In a hurry?{" "}
                  <a href={loaderUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                    Open the loader on GitHub ↗
                  </a>
                  , click <strong>Run workflow</strong>, then the green <strong>Run workflow</strong> button.
                  It takes a few minutes; then refresh this page.
                </>
              )}
            </li>
            <li>To remove a document, delete it from the folder (or move it out). It disappears after the next load.</li>
          </ol>
          <p className="mt-3 text-xs text-neutral-500">
            The free search service loads about 1,000 passages a day, so a big batch of new files can take a few
            days to finish. Nothing needs restarting — each load carries on where the last one stopped.
          </p>
        </section>

        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <section aria-label="Document list">
          <div className="mb-2 flex items-center gap-3">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a document…"
              aria-label="Find a document"
              className="w-full min-w-0 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
            />
            <button onClick={load} className="shrink-0 text-xs text-neutral-600 underline">
              Refresh
            </button>
          </div>
          <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
            {docs === null ? (
              <li className="px-4 py-6 text-center text-sm text-neutral-400">Loading…</li>
            ) : shown.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-neutral-400">
                {docs.length ? "No documents match." : "No documents yet."}
              </li>
            ) : (
              shown.map((d) => {
                const s = STATUS[d.status] ?? { label: d.status, style: "bg-neutral-100 text-neutral-600" };
                return (
                  <li key={d.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0 text-sm">
                      <div className="break-words">{d.title}</div>
                      {d.drive_file_id && (
                        <a
                          href={`https://drive.google.com/file/d/${d.drive_file_id}/view`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 underline"
                        >
                          Open in Google Drive ↗
                        </a>
                      )}
                      {s.help && <div className="text-xs text-neutral-500">{s.help}</div>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${s.style}`}>{s.label}</span>
                  </li>
                );
              })
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}
