"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api, errorMessage, REPO_URL } from "@/lib/supabase";

interface Doc {
  id: string;
  title: string;
  mime_type: string | null;
  status: string;
  drive_modified_at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-green-100 text-green-800",
  ingesting: "bg-blue-100 text-blue-800",
  pending: "bg-neutral-100 text-neutral-600",
  error: "bg-red-100 text-red-800",
};

export default function AdminPage() {
  return <AuthGate>{() => <Corpus />}</AuthGate>;
}

/**
 * Read-only corpus status. Documents are loaded by the "Ingest Drive corpus"
 * GitHub Action (scripts/ingest.mjs), which runs daily — never by the website.
 */
function Corpus() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [chunks, setChunks] = useState(0);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await api("/documents");
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      setDocs(data.documents ?? []);
      setChunks(data.embeddedChunks ?? 0);
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Corpus</h1>
          <p className="text-xs text-neutral-500">Documents loaded from Google Drive into the search index</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="text-xs text-neutral-600 underline">
            Refresh
          </button>
          <Link href="/" className="text-xs text-blue-600 underline">
            ← chat
          </Link>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-600">
        <strong>{counts.ready ?? 0}</strong> ready · <strong>{(counts.ingesting ?? 0) + (counts.pending ?? 0)}</strong>{" "}
        in progress · <strong>{counts.error ?? 0}</strong> skipped/error · <strong>{chunks.toLocaleString()}</strong>{" "}
        searchable passages.
        <div className="mt-1 text-neutral-500">
          New and changed Drive files are loaded by the daily{" "}
          {REPO_URL ? (
            <a
              href={`${REPO_URL}/actions/workflows/ingest.yml`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              Ingest Drive corpus
            </a>
          ) : (
            "Ingest Drive corpus"
          )}{" "}
          job — run it there to load files immediately.
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
            <th className="py-2">Document</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {docs === null ? (
            <tr>
              <td colSpan={2} className="py-6 text-center text-neutral-400">
                Loading…
              </td>
            </tr>
          ) : docs.length === 0 ? (
            <tr>
              <td colSpan={2} className="py-6 text-center text-neutral-400">
                No documents yet.
              </td>
            </tr>
          ) : (
            docs.map((d) => (
              <tr key={d.id} className="border-b border-neutral-100">
                <td className="py-2 pr-2">{d.title}</td>
                <td className="py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[d.status] ?? ""}`}>{d.status}</span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
