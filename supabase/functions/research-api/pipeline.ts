/**
 * Answer pipeline (runtime-agnostic: only web-standard fetch/AbortSignal, so it
 * runs under Deno in Supabase Edge Functions and under Node in tests).
 *
 *   1. retrieve  - embed the question (Gemini) and search the document corpus
 *                  (pgvector `match_chunks`). Closed corpus: no web search.
 *   2. draft     - fan the question out to a model ensemble via OpenRouter.
 *   3. check     - a checker model consolidates the drafts against the sources.
 *   4. ground    - deterministic code checks (grounding.ts) remove any sentence
 *                  citing authority or quoting text not found in the sources.
 *
 * Nothing unverified is streamed to the client: progress is reported as stage
 * events and the answer is only sent once it has passed step 4.
 */

import {
  enforceGrounding,
  NOTHING_LEFT,
  type CitationCheck,
  type GroundingReport,
  type QuoteCheck,
  type Removal,
} from "./grounding.ts";

export type Tier = "free" | "paid";
export type Confidence = "high" | "medium" | "low";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Source {
  id: string;
  type: "drive";
  title: string;
  url?: string;
  snippet: string;
  similarity: number;
}

export type Stage = "retrieving" | "drafting" | "checking" | "verifying";

export type StreamEvent =
  | { type: "stage"; stage: Stage }
  | { type: "sources"; sources: Source[] }
  | { type: "meta"; tier: Tier; generators: string[]; checker: string }
  | {
    type: "final";
    text: string;
    removed: Removal[];
    citations: CitationCheck[];
    quotes: QuoteCheck[];
    checker: string;
  }
  | { type: "done"; confidence: Confidence; unsupported: string[] }
  | { type: "error"; message: string }
  | { type: "ping" };

export interface ModelSet {
  generators: string[];
  checker: string[]; // tried in order until one answers
}

export interface Config {
  supabaseUrl: string;
  serviceKey: string;
  openrouterKey?: string;
  geminiKey?: string;
  embedModel: string;
  embedDim: number;
  topK: number;
  minSimilarity: number;
  snippetChars: number;
  fanout: number;
  models: Record<Tier, ModelSet>;
  appUrl: string;
  generatorTimeoutMs: number;
  checkerTimeoutMs: number;
}

/** A misconfiguration the operator must fix - shown to the user verbatim. */
export class ConfigError extends Error {}

export const ABSTAIN =
  "Your documents don't contain anything relevant to this question, so I can't answer it from them.";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const GENERATOR_SYSTEM = `You are a legal research assistant. Answer the user's question USING ONLY the provided sources.

Rules:
- Every factual or legal claim MUST cite a source tag in square brackets, e.g. [S1] or [S2].
- Use ONLY information found in the sources. Do not use outside knowledge.
- Mention a case name, case citation or statute ONLY if it appears in the sources, written as it appears there.
- Put text in quotation marks ONLY when it is copied word-for-word from a source.
- If the sources do not answer the question, say exactly: "The provided sources do not address this."
- Be precise and concise.
- This is legal information, not legal advice.`;

export const CHECKER_SYSTEM = `You are a strict verifier and editor for a legal research tool. You receive the user's question, SOURCES (each tagged [S#]), and CANDIDATE ANSWERS drafted by other models.

Your job:
1. Produce ONE consolidated answer that uses ONLY the sources.
2. Keep a claim ONLY if a cited source actually supports it. Delete anything unsupported; never add claims of your own.
3. Every retained claim carries its [S#] citation inline.
4. Mention a case name, case citation or statute ONLY if it appears in the sources, written as it appears there. Candidate answers may contain authorities that are NOT in the sources \u2014 remove them.
5. Use quotation marks ONLY for text copied word-for-word from a source.
6. If the sources are insufficient, say so plainly instead of guessing.
7. This is legal information, not legal advice.

Your output is checked by software afterwards: any case citation, case name or statute not found in the sources, and any quotation not found word-for-word in a source, is automatically deleted together with its sentence.

Output format (exactly):
- First, the final answer in Markdown, with inline [S#] citations.
- Then, on a new line, the literal sentinel <<<META>>> immediately followed by one compact JSON object and nothing after it:
<<<META>>>{"confidence":"high|medium|low","unsupported":["short note on each claim you dropped"],"quotes":[{"source":"S1","text":"exact words copied from S1 that support a key claim"}]}

"quotes": for each key claim, copy the supporting passage EXACTLY as it appears in that source \u2014 word-for-word, no paraphrase, at most 300 characters. These are shown to the user as evidence.
Set "confidence" to "high" only when every key claim is directly supported; "medium" when partially supported; "low" when the sources are weak or off-point.`;

export function formatSources(sources: Source[]): string {
  return sources
    .map((s) => `[${s.id}] ${s.title}${s.url ? ` \u2014 ${s.url}` : ""}\n${s.snippet}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return signal && any ? any([signal, timeout]) : timeout;
}

/** Legacy service_role keys are JWTs (sent as Bearer too); new sb_secret_ keys go in apikey only. */
export function serviceHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return h;
}

async function errorText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n && Number.isFinite(n) ? v.map((x) => x / n) : v;
}

// ---------------------------------------------------------------------------
// 1. Retrieval
// ---------------------------------------------------------------------------

async function embedQuery(cfg: Config, text: string, signal?: AbortSignal): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.embedModel}:embedContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": cfg.geminiKey!, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${cfg.embedModel}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: cfg.embedDim,
    }),
    signal: withTimeout(signal, 20_000),
  });
  if (!res.ok) throw new Error(`Gemini embedding failed (HTTP ${res.status}): ${await errorText(res)}`);
  const values = (await res.json())?.embedding?.values;
  if (!Array.isArray(values)) throw new Error("Gemini embedding returned no vector.");
  return l2normalize(values as number[]);
}

interface MatchRow {
  content: string;
  title: string | null;
  drive_file_id: string | null;
  similarity: number;
}

export async function retrieve(cfg: Config, query: string, signal?: AbortSignal): Promise<Source[]> {
  const vector = await embedQuery(cfg, query, signal);
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/match_chunks`, {
    method: "POST",
    headers: serviceHeaders(cfg.serviceKey),
    body: JSON.stringify({ query_embedding: `[${vector.join(",")}]`, match_count: cfg.topK }),
    signal: withTimeout(signal, 20_000),
  });
  if (!res.ok) throw new Error(`Document search failed (HTTP ${res.status}): ${await errorText(res)}`);
  const rows = (await res.json()) as MatchRow[];

  return rows
    .filter((r) => Number(r.similarity) >= cfg.minSimilarity)
    .map((r, i) => ({
      id: `S${i + 1}`,
      type: "drive" as const,
      title: r.title || "document",
      url: r.drive_file_id ? `https://drive.google.com/file/d/${r.drive_file_id}/view` : undefined,
      snippet: String(r.content ?? "").slice(0, cfg.snippetChars),
      similarity: Math.round(Number(r.similarity) * 1000) / 1000,
    }));
}

// ---------------------------------------------------------------------------
// 2-3. Models (OpenRouter)
// ---------------------------------------------------------------------------

type Msg = { role: string; content: string };

export async function chatComplete(
  cfg: Config,
  model: string,
  messages: Msg[],
  timeoutMs: number,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openrouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": cfg.appUrl,
      "X-Title": "Research Fact Base",
    },
    body: JSON.stringify({ model, messages, temperature }),
    signal: withTimeout(signal, timeoutMs),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await errorText(res)}`);
  const data = await res.json();
  if (data?.error) throw new Error(`${model}: ${data.error.message ?? JSON.stringify(data.error)}`);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${model}: empty response`);
  return content;
}

interface Draft {
  model: string;
  content: string;
  error?: string;
}

async function runGenerators(
  cfg: Config,
  models: string[],
  question: string,
  history: ChatMessage[],
  sources: Source[],
  signal?: AbortSignal,
): Promise<Draft[]> {
  const messages: Msg[] = [
    { role: "system", content: GENERATOR_SYSTEM },
    ...history,
    { role: "user", content: `SOURCES:\n${formatSources(sources)}\n\nQUESTION:\n${question}` },
  ];
  const settled = await Promise.allSettled(
    models.map((m) => chatComplete(cfg, m, messages, cfg.generatorTimeoutMs, 0.2, signal)),
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { model: models[i], content: r.value }
      : { model: models[i], content: "", error: String(r.reason) },
  );
}

export interface CheckerMeta {
  confidence: Confidence;
  unsupported: string[];
  quotes: { source?: unknown; text?: unknown }[];
}

export function parseCheckerOutput(raw: string, hasSources: boolean): { answer: string; meta: CheckerMeta } {
  const at = raw.indexOf("<<<META>>>");
  let answer = (at === -1 ? raw : raw.slice(0, at)).trim();
  // Unwrap an answer the model put inside a ```markdown fence.
  const fenced = answer.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) answer = fenced[1].trim();

  const meta: CheckerMeta = { confidence: hasSources ? "medium" : "low", unsupported: [], quotes: [] };
  if (at !== -1) {
    const tail = raw.slice(at + "<<<META>>>".length);
    const start = tail.indexOf("{");
    const end = tail.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(tail.slice(start, end + 1));
        if (["high", "medium", "low"].includes(parsed?.confidence)) meta.confidence = parsed.confidence;
        if (Array.isArray(parsed?.unsupported)) {
          meta.unsupported = parsed.unsupported.map(String).filter(Boolean).slice(0, 10);
        }
        if (Array.isArray(parsed?.quotes)) meta.quotes = parsed.quotes.slice(0, 12);
      } catch {
        // keep defaults; the grounding checks still run on the answer
      }
    }
  }
  return { answer, meta };
}

async function runChecker(
  cfg: Config,
  models: string[],
  question: string,
  history: ChatMessage[],
  sources: Source[],
  drafts: Draft[],
  signal?: AbortSignal,
): Promise<{ answer: string; meta: CheckerMeta; model: string }> {
  const candidates =
    drafts
      .filter((d) => d.content)
      .map((d, i) => `--- Candidate ${i + 1} (${d.model}) ---\n${d.content}`)
      .join("\n\n") || "(No candidate answers were produced \u2014 write the answer yourself from the sources.)";

  const messages: Msg[] = [
    { role: "system", content: CHECKER_SYSTEM },
    ...history,
    {
      role: "user",
      content: `SOURCES:\n${formatSources(sources)}\n\nCANDIDATE ANSWERS:\n${candidates}\n\nQUESTION:\n${question}`,
    },
  ];

  const errors: string[] = [];
  for (const model of models) {
    try {
      const raw = await chatComplete(cfg, model, messages, cfg.checkerTimeoutMs, 0.1, signal);
      return { ...parseCheckerOutput(raw, sources.length > 0), model };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(String(err instanceof Error ? err.message : err));
    }
  }
  const draftErrors = drafts.filter((d) => d.error).map((d) => d.error!);
  throw new Error(
    "The AI models didn't respond. Free OpenRouter models are sometimes unavailable or rate-limited \u2014 " +
      "try again shortly or use the Claude (paid) tier.\n\nDetails: " +
      [...errors, ...draftErrors].join(" | ").slice(0, 600),
  );
}

// ---------------------------------------------------------------------------
// 4. Confidence after grounding
// ---------------------------------------------------------------------------

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const cap = (c: Confidence, max: Confidence): Confidence => (RANK[c] > RANK[max] ? max : c);

export function finalConfidence(meta: CheckerMeta, report: GroundingReport): {
  confidence: Confidence;
  unsupported: string[];
} {
  let confidence = meta.confidence;
  const notes = [...meta.unsupported];

  if (report.text === NOTHING_LEFT) {
    return { confidence: "low", unsupported: notes };
  }
  if (report.removed.length) {
    confidence = cap(confidence, "medium");
    notes.push(
      `${report.removed.length} sentence${report.removed.length === 1 ? " was" : "s were"} removed by the automatic source checks.`,
    );
  }
  if (report.quotes.some((q) => q.status === "not_found")) {
    confidence = "low";
    notes.push("A supporting quote could not be found in your documents.");
  } else if (report.quotes.some((q) => q.status === "misattributed")) {
    confidence = cap(confidence, "medium");
    notes.push("A supporting quote was attributed to the wrong source.");
  }
  if (!report.quotes.length) {
    confidence = cap(confidence, "medium");
    notes.push("No verifiable supporting quotes were provided.");
  }
  return { confidence, unsupported: notes };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runPipeline(
  cfg: Config,
  messages: ChatMessage[],
  tier: Tier,
  emit: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!cfg.geminiKey) {
    throw new ConfigError(
      "The server is missing GEMINI_API_KEY, so it can't search your documents. " +
        "Add it in Supabase \u2192 Edge Functions \u2192 Secrets.",
    );
  }
  if (!cfg.openrouterKey) {
    throw new ConfigError(
      "The server is missing OPENROUTER_API_KEY, so it can't draft answers. " +
        "Add it in Supabase \u2192 Edge Functions \u2192 Secrets.",
    );
  }

  const question = messages[messages.length - 1].content;
  const history = messages.slice(0, -1).slice(-6);

  emit({ type: "stage", stage: "retrieving" });
  const sources = await retrieve(cfg, question, signal);
  emit({ type: "sources", sources });

  if (!sources.length) {
    // Deterministic abstention: nothing retrieved, so no model is asked to answer.
    emit({ type: "final", text: ABSTAIN, removed: [], citations: [], quotes: [], checker: "" });
    emit({ type: "done", confidence: "low", unsupported: [] });
    return;
  }

  const set = cfg.models[tier];
  const generators = set.generators.slice(0, Math.max(1, cfg.fanout));
  emit({ type: "meta", tier, generators, checker: set.checker[0] ?? "" });

  emit({ type: "stage", stage: "drafting" });
  const drafts = await runGenerators(cfg, generators, question, history, sources, signal);

  emit({ type: "stage", stage: "checking" });
  const checked = await runChecker(cfg, set.checker, question, history, sources, drafts, signal);

  emit({ type: "stage", stage: "verifying" });
  const report = enforceGrounding(checked.answer, sources, checked.meta.quotes);
  const { confidence, unsupported } = finalConfidence(checked.meta, report);

  emit({
    type: "final",
    text: report.text,
    removed: report.removed,
    citations: report.citations,
    quotes: report.quotes,
    checker: checked.model,
  });
  emit({ type: "done", confidence, unsupported });
}
