"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Session } from "@supabase/supabase-js";
import { api, errorMessage, supabase } from "@/lib/supabase";

type Tier = "free" | "paid";
type Confidence = "high" | "medium" | "low";
type Stage = "retrieving" | "drafting" | "checking" | "verifying";

interface Source {
  id: string;
  title: string;
  url?: string;
  snippet: string;
  similarity?: number;
}
interface CitationCheck {
  text: string;
  kind: string;
  grounded: boolean;
}
interface QuoteCheck {
  source: string;
  text: string;
  status: "verified" | "misattributed" | "not_found";
  foundIn?: string;
}
interface Removal {
  sentence: string;
  reason: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  stage?: Stage;
  sources?: Source[];
  generators?: string[];
  checker?: string;
  tier?: Tier;
  citations?: CitationCheck[];
  quotes?: QuoteCheck[];
  removed?: Removal[];
  confidence?: Confidence;
  unsupported?: string[];
  pending?: boolean;
  error?: string;
}

const CONF_STYLE: Record<Confidence, string> = {
  high: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-red-100 text-red-800 border-red-200",
};

function stageLabel(m: Msg): string {
  switch (m.stage) {
    case "drafting":
      return `Drafting with ${m.generators?.length ?? "several"} model${m.generators?.length === 1 ? "" : "s"}…`;
    case "checking":
      return "Cross-checking the drafts against your documents…";
    case "verifying":
      return "Verifying every citation and quote…";
    default:
      return "Searching your documents…";
  }
}

export default function Chat({ session }: { session: Session }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [tier, setTier] = useState<Tier>("free");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function patchLast(patch: Partial<Msg>) {
    setMessages((prev) => {
      const copy = [...prev];
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
      return copy;
    });
  }

  async function run(history: { role: string; content: string }[], useTier: Tier) {
    setMessages((prev) => [...prev, { role: "assistant", content: "", pending: true, tier: useTier }]);
    setBusy(true);
    try {
      const res = await api("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, tier: useTier }),
      });
      if (!res.ok || !res.body) throw new Error(await errorMessage(res));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          switch (ev.type) {
            case "stage":
              patchLast({ stage: ev.stage as Stage });
              break;
            case "sources":
              patchLast({ sources: ev.sources as Source[] });
              break;
            case "meta":
              patchLast({ generators: ev.generators as string[], checker: ev.checker as string, tier: ev.tier as Tier });
              break;
            case "final":
              patchLast({
                content: ev.text as string,
                removed: ev.removed as Removal[],
                citations: ev.citations as CitationCheck[],
                quotes: ev.quotes as QuoteCheck[],
                checker: (ev.checker as string) || undefined,
              });
              break;
            case "done":
              patchLast({ confidence: ev.confidence as Confidence, unsupported: ev.unsupported as string[], pending: false });
              break;
            case "error":
              patchLast({ error: ev.message as string, pending: false });
              break;
          }
        }
      }
      patchLast({ pending: false });
    } catch (e) {
      patchLast({ error: e instanceof Error ? e.message : String(e), pending: false });
    } finally {
      setBusy(false);
    }
  }

  /** Prior turns sent as context: only completed, verified answers. */
  function historyUpTo(list: Msg[]) {
    return list
      .filter((m) => m.content && !m.error && !m.pending)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    const history = [...historyUpTo(messages), { role: "user", content: q }];
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    run(history, tier);
  }

  function rerunWithClaude() {
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0 || busy) return;
    run(historyUpTo(messages.slice(0, lastUser + 1)), "paid");
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold">Research Fact Base</h1>
          <p className="text-xs text-neutral-500">Answers from your documents only — every citation checked</p>
        </div>
        <div className="flex items-center gap-3">
          <TierToggle tier={tier} setTier={setTier} disabled={busy} />
          <Link href="/admin/" className="text-xs text-neutral-600 underline">
            Corpus
          </Link>
          <button
            onClick={() => supabase?.auth.signOut()}
            className="text-xs text-neutral-500 underline"
            title={session.user.email ?? ""}
          >
            Sign out
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, i) => <Bubble key={i} m={m} onEscalate={rerunWithClaude} busy={busy} />)
          )}
        </div>
      </div>

      <div className="border-t border-neutral-200 bg-white">
        <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 py-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            rows={1}
            placeholder="Ask a question about your documents…"
            className="max-h-40 flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>
        <p className="pb-3 text-center text-[11px] text-neutral-400">Legal information, not legal advice.</p>
      </div>
    </div>
  );
}

function TierToggle({ tier, setTier, disabled }: { tier: Tier; setTier: (t: Tier) => void; disabled: boolean }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 text-xs">
      {(["free", "paid"] as Tier[]).map((t) => (
        <button
          key={t}
          onClick={() => setTier(t)}
          disabled={disabled}
          className={`rounded-md px-2.5 py-1 font-medium transition ${
            tier === t ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500"
          } disabled:opacity-50`}
        >
          {t === "free" ? "Free (ensemble)" : "Claude (paid)"}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-24 text-center">
      <h2 className="text-lg font-semibold text-neutral-700">Ask a question about your documents</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
        Answers come only from your loaded documents. Before you see an answer, software checks that every case,
        citation and quotation in it actually appears in those documents — anything that doesn&apos;t is removed, and
        you&apos;re told what and why.
      </p>
    </div>
  );
}

function Bubble({ m, onEscalate, busy }: { m: Msg; onEscalate: () => void; busy: boolean }) {
  if (m.role === "user") {
    return (
      <div className="mb-5 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-neutral-900 px-4 py-2 text-sm text-white">
          {m.content}
        </div>
      </div>
    );
  }

  const showEscalate = !m.pending && !m.error && m.tier === "free" && m.confidence && m.confidence !== "high";

  return (
    <div className="mb-8">
      {m.pending && !m.content ? (
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-400" />
          {stageLabel(m)}
        </div>
      ) : (
        m.content && (
          <div className="answer text-sm text-neutral-800">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
        )
      )}

      {m.error && (
        <div className="mt-2 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {m.error}
        </div>
      )}

      {m.removed && m.removed.length > 0 && <Removed items={m.removed} />}
      {(m.citations?.length || m.quotes?.length) ? <Checks citations={m.citations ?? []} quotes={m.quotes ?? []} /> : null}
      {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}

      {m.unsupported && m.unsupported.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Notes:</span> {m.unsupported.join(" ")}
        </div>
      )}

      {!m.pending && (m.confidence || m.checker) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
          {m.confidence && (
            <span className={`rounded-full border px-2 py-0.5 font-medium ${CONF_STYLE[m.confidence]}`}>
              confidence: {m.confidence}
            </span>
          )}
          {m.generators && m.generators.length > 0 && <span>drafted by {m.generators.join(", ")}</span>}
          {m.checker && <span>· checked by {m.checker}</span>}
          {showEscalate && (
            <button
              onClick={onEscalate}
              disabled={busy}
              className="ml-1 rounded-full border border-neutral-300 bg-white px-2 py-0.5 font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
            >
              ↑ Re-run with Claude (paid)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Removed({ items }: { items: Removal[] }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="mb-1.5 text-xs font-medium text-amber-900">
        Removed by source checks ({items.length}) — the AI wrote these, but they couldn&apos;t be verified against
        your documents
      </div>
      <ul className="space-y-1.5">
        {items.map((r, i) => (
          <li key={i} className="text-xs text-amber-900">
            <span className="line-through decoration-amber-500/60">{r.sentence}</span>
            <div className="text-[11px] text-amber-700">{r.reason}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const QUOTE_BADGE: Record<QuoteCheck["status"], { label: string; style: string }> = {
  verified: { label: "✓ verified", style: "border-green-200 bg-green-50 text-green-800" },
  misattributed: { label: "⚠ wrong source", style: "border-amber-200 bg-amber-50 text-amber-800" },
  not_found: { label: "✗ not found", style: "border-red-200 bg-red-50 text-red-800" },
};

function Checks({ citations, quotes }: { citations: CitationCheck[]; quotes: QuoteCheck[] }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-neutral-200 bg-white p-3">
      {quotes.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-neutral-600">Supporting passages</div>
          <ul className="space-y-2">
            {quotes.map((q, i) => (
              <li key={i} className="text-xs">
                <span className={`mr-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${QUOTE_BADGE[q.status].style}`}>
                  {QUOTE_BADGE[q.status].label}
                </span>
                <span className="mr-1 rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-500">{q.source}</span>
                <span className="italic text-neutral-700">“{q.text}”</span>
                {q.status === "misattributed" && q.foundIn && (
                  <span className="ml-1 text-[11px] text-amber-700">(actually in {q.foundIn})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {citations.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-neutral-600">Citations checked against your documents</div>
          <div className="flex flex-wrap gap-1.5">
            {citations.map((c, i) => (
              <span
                key={i}
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                  c.grounded ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-700"
                }`}
                title={c.grounded ? "Appears in your documents" : "Not in your documents — removed from the answer"}
              >
                {c.grounded ? "✓" : "✗"} {c.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <details className="mt-3 rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-600">
        Passages searched ({sources.length}) — click to read exactly what the AI was given
      </summary>
      <ul className="space-y-2 px-3 pb-3">
        {sources.map((s) => (
          <li key={s.id} className="text-xs text-neutral-600">
            <details>
              <summary className="cursor-pointer">
                <span className="mr-1 rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-500">{s.id}</span>
                <span className="text-neutral-700">{s.title}</span>
                {typeof s.similarity === "number" && (
                  <span className="ml-1 text-[10px] text-neutral-400">match {s.similarity.toFixed(2)}</span>
                )}
              </summary>
              <p className="mt-1 whitespace-pre-wrap rounded bg-neutral-50 p-2 text-[11px] leading-relaxed text-neutral-700">
                {s.snippet}
              </p>
              {s.url && (
                <a href={s.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-blue-600 underline">
                  Open document in Google Drive ↗
                </a>
              )}
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}
