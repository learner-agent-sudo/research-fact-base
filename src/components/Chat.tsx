"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Tier = "free" | "paid";
type Confidence = "high" | "medium" | "low";

interface Source {
  id: string;
  type: "drive" | "web" | "upload";
  title: string;
  url?: string;
  snippet: string;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  generators?: string[];
  checker?: string;
  tier?: Tier;
  confidence?: Confidence;
  unsupported?: string[];
  streaming?: boolean;
  error?: string;
}

const CONF_STYLE: Record<Confidence, string> = {
  high: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-red-100 text-red-800 border-red-200",
};

export default function Chat() {
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

  function appendLast(text: string) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = { ...copy[copy.length - 1] };
      last.content += text;
      copy[copy.length - 1] = last;
      return copy;
    });
  }

  async function run(apiMessages: { role: string; content: string }[], useTier: Tier) {
    setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true, tier: useTier }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, tier: useTier }),
      });
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          switch (ev.type) {
            case "sources":
              patchLast({ sources: ev.sources as Source[] });
              break;
            case "meta":
              patchLast({ generators: ev.generators as string[], checker: ev.checker as string, tier: ev.tier as Tier });
              break;
            case "delta":
              appendLast(ev.text as string);
              break;
            case "done":
              patchLast({ confidence: ev.confidence as Confidence, unsupported: ev.unsupported as string[], streaming: false });
              break;
            case "error":
              patchLast({ error: ev.message as string, streaming: false });
              break;
          }
        }
      }
      patchLast({ streaming: false });
    } catch (e) {
      patchLast({ error: e instanceof Error ? e.message : String(e), streaming: false });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    const apiMessages = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: q },
    ];
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    run(apiMessages, tier);
  }

  function rerunWithClaude() {
    // Re-answer the last user turn on the paid tier, appending a fresh answer.
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx < 0 || busy) return;
    const apiMessages = messages
      .slice(0, lastUserIdx + 1)
      .map((m) => ({ role: m.role, content: m.content }));
    run(apiMessages, "paid");
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-5 py-3">
        <div>
          <h1 className="text-sm font-semibold">Research Fact Base</h1>
          <p className="text-xs text-neutral-500">Grounded &amp; verified legal research</p>
        </div>
        <TierToggle tier={tier} setTier={setTier} disabled={busy} />
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {messages.length === 0 ? <EmptyState /> : messages.map((m, i) => <Bubble key={i} m={m} onEscalate={rerunWithClaude} busy={busy} />)}
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
            placeholder="Ask a legal question…"
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
        <p className="pb-3 text-center text-[11px] text-neutral-400">
          Legal information, not legal advice.
        </p>
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
      <h2 className="text-lg font-semibold text-neutral-700">Ask a legal question</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
        Answers are drawn only from your designated documents and a live web search, then checked
        by a stronger model before you see them. Every claim carries a linked source.
      </p>
    </div>
  );
}

function Bubble({ m, onEscalate, busy }: { m: Msg; onEscalate: () => void; busy: boolean }) {
  if (m.role === "user") {
    return (
      <div className="mb-5 flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-neutral-900 px-4 py-2 text-sm text-white">{m.content}</div>
      </div>
    );
  }

  const showEscalate = !m.streaming && m.tier === "free" && m.confidence && m.confidence !== "high";

  return (
    <div className="mb-6">
      <div className="answer text-sm text-neutral-800">
        {m.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
        ) : (
          <span className="text-neutral-400">Gathering sources and drafting…</span>
        )}
        {m.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-400 align-middle" />}
      </div>

      {m.error && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {m.error}
        </div>
      )}

      {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}

      {m.unsupported && m.unsupported.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">Flagged / unverified:</span> {m.unsupported.join("; ")}
        </div>
      )}

      {!m.streaming && (m.confidence || m.checker) && (
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

function Sources({ sources }: { sources: Source[] }) {
  return (
    <details className="mt-3 rounded-lg border border-neutral-200 bg-white" open>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-600">
        Sources ({sources.length})
      </summary>
      <ul className="space-y-1 px-3 pb-3">
        {sources.map((s) => (
          <li key={s.id} className="text-xs text-neutral-600">
            <span className="mr-1 rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-500">
              {s.id}
            </span>
            <span className="mr-1 text-[10px] uppercase text-neutral-400">{s.type}</span>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                {s.title}
              </a>
            ) : (
              <span>{s.title}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
