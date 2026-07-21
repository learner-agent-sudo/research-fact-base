"use client";

import { useCallback, useEffect, useState } from "react";

interface Doc {
  id: string;
  title: string;
  mime_type: string | null;
  status: string;
  drive_modified_at: string | null;
  created_at: string;
}

const STATUS_STYLE: Record<string, string> = {
  ready: "bg-green-100 text-green-800",
  ingesting: "bg-blue-100 text-blue-800",
  pending: "bg-neutral-100 text-neutral-600",
  error: "bg-red-100 text-red-800",
};

export default function Admin() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [configured, setConfigured] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/documents");
    const data = await res.json();
    setDocs(data.documents || []);
    setConfigured(data.configured !== false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A single lightweight round. Bulk ingestion is done by the background job
  // (scripts/ingest.mjs via GitHub Actions), which never loads Vercel. This
  // button is only for a quick top-up / status check.
  async function sync() {
    setSyncing(true);
    setLog("Running one ingest round…");
    try {
      const res = await fetch("/api/ingest/sync", { method: "POST" });
      const text = await res.text();
      let data: { error?: string; done?: boolean; remaining?: number } | null = null;
      try {
        data = JSON.parse(text);
      } catch {
        setLog("A batch timed out (Vercel's 60s limit). For a full load, use the background job — see docs/BACKGROUND_INGEST.md.");
        await load();
        return;
      }
      if (data?.error) setLog(`Error: ${data.error}`);
      else if (data?.done) setLog("✅ Up to date — everything is embedded.");
      else setLog(`${data?.remaining ?? "?"} chunks still need embedding. For a full load, run the background job (docs/BACKGROUND_INGEST.md) instead of clicking repeatedly here.`);
      await load();
    } catch (e) {
      setLog(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Corpus admin</h1>
          <p className="text-xs text-neutral-500">Google Drive → vector index</p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/" className="text-xs text-blue-600 underline">
            ← chat
          </a>
          <button
            onClick={sync}
            disabled={syncing}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {syncing ? "Syncing…" : "Sync Drive now"}
          </button>
        </div>
      </div>

      {!configured && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Supabase is not configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env.local</code>.
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
            <th className="py-2">Document</th>
            <th className="py-2">Type</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {docs.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-6 text-center text-neutral-400">
                No documents yet. Add files to the Drive corpus folder and click “Sync Drive now”.
              </td>
            </tr>
          ) : (
            docs.map((d) => (
              <tr key={d.id} className="border-b border-neutral-100">
                <td className="py-2 pr-2">{d.title}</td>
                <td className="py-2 pr-2 text-xs text-neutral-500">
                  {(d.mime_type || "").split(".").pop()}
                </td>
                <td className="py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[d.status] || ""}`}>
                    {d.status}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {log && (
        <pre className="mt-4 overflow-x-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100">
          {log}
        </pre>
      )}
    </div>
  );
}
