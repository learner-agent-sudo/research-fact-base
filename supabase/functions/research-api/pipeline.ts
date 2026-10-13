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
  /** The whole answer must be sent within this; Supabase stops a request at 150s (free plan). */
  timeLimitMs: number;
  /** Once one draft is in, how much longer to wait for the other drafting models. */
  draftGraceMs: number;
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

/** Aborts when any of the given signals does. */
function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 1) return list[0];
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) c.abort(s.reason);
    else s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return anySignal(signal, AbortSignal.timeout(Math.max(1, ms)));
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

interface CatalogModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalog: { at: number; models: CatalogModel[] } | null = null;

/** Forget the cached OpenRouter model list (tests). */
export function clearModelCatalog() {
  catalog = null;
}

/** OpenRouter's public model list, cached for an hour; null if it can't be fetched. */
async function modelCatalog(cfg: Config, signal?: AbortSignal): Promise<CatalogModel[] | null> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${cfg.openrouterKey}` },
      signal: withTimeout(signal, 10_000),
    });
    const data = res.ok ? (await res.json())?.data : null;
    if (!res.ok) await res.body?.cancel();
    if (!Array.isArray(data) || !data.length) return catalog?.models ?? null;
    catalog = { at: Date.now(), models: data as CatalogModel[] };
    return catalog.models;
  } catch {
    return catalog?.models ?? null;
  }
}

const isFree = (m: CatalogModel) =>
  m.id.endsWith(":free") ||
  (m.pricing?.prompt !== undefined && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);

// Free models to fall back on when the configured ones stop being free, best
// families first. Small (<10B) and non-chat models are skipped.
const FREE_FAMILIES = [/deepseek/, /qwen/, /llama-(4|3\.3)/, /gemini|gemma-3-27b/, /gpt-oss/, /kimi|glm|mistral/];
const TOO_SMALL = /[-_:/](0\.\d+|1|1\.5|2|3|4|7|8|9)b\b/i;
const NOT_CHAT = /[-_]vl\b|vision|embed|guard|audio|tts|image/i;

function rankedFree(models: CatalogModel[]): string[] {
  const family = (id: string) => {
    const i = FREE_FAMILIES.findIndex((re) => re.test(id));
    return i === -1 ? FREE_FAMILIES.length : i;
  };
  return models
    .filter((m) => isFree(m) && (m.context_length ?? 0) >= 16_000 && !TOO_SMALL.test(m.id) && !NOT_CHAT.test(m.id))
    .sort((a, b) => family(a.id) - family(b.id) || (b.created ?? 0) - (a.created ?? 0))
    .map((m) => m.id);
}

const unique = (ids: string[]) => [...new Set(ids)];

/**
 * The models to use for a tier, checked against OpenRouter's live list:
 * configured models that are still offered (and, for the free tier, still
 * free) come first, then the best other candidates. Free slugs come and go,
 * so this keeps the app answering without a redeploy. If the list can't be
 * fetched, the configured models are used as-is.
 */
export async function resolveModels(cfg: Config, tier: Tier, signal?: AbortSignal): Promise<ModelSet> {
  const configured = cfg.models[tier];
  const models = await modelCatalog(cfg, signal);
  if (!models) return configured;

  const offered = new Set(models.filter((m) => (tier === "free" ? isFree(m) : !isFree(m))).map((m) => m.id));
  const fallbacks =
    tier === "free"
      ? rankedFree(models)
      : models
        .filter((m) => /^anthropic\/claude-[\w.-]*sonnet/.test(m.id) && !isFree(m))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => m.id);
  const pick = (ids: string[]) => unique([...ids.filter((id) => offered.has(id)), ...fallbacks]);

  // Never more drafting models than configured (the paid tier drafts with one).
  const generators = pick(configured.generators).slice(0, Math.max(1, configured.generators.length));
  const checker = pick(configured.checker).slice(0, 4);
  if (!generators.length || !checker.length) return configured;
  return { generators, checker };
}

export interface ModelOption {
  id: string;
  name: string;
  context?: number;
}

const PAID_PROVIDERS = /^(anthropic|openai|google|x-ai|deepseek|mistralai|qwen|meta-llama|moonshotai)\//;

/** Choices for the Settings page: chat models free right now, and paid ones from major providers. */
export async function modelOptions(
  cfg: Config,
  signal?: AbortSignal,
): Promise<{ free: ModelOption[]; paid: ModelOption[] } | null> {
  const models = await modelCatalog(cfg, signal);
  if (!models) return null;
  const chat = (m: CatalogModel) => (m.context_length ?? 0) >= 16_000 && !NOT_CHAT.test(m.id);
  const option = (m: CatalogModel): ModelOption => ({ id: m.id, name: m.name || m.id, context: m.context_length });
  return {
    free: models
      .filter((m) => isFree(m) && chat(m))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
      .map(option),
    paid: models
      .filter((m) => !isFree(m) && chat(m) && PAID_PROVIDERS.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(option),
  };
}

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
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Draft[]> {
  const messages: Msg[] = [
    { role: "system", content: GENERATOR_SYSTEM },
    ...history,
    { role: "user", content: `SOURCES:\n${formatSources(sources)}\n\nQUESTION:\n${question}` },
  ];
  // Once one draft is in, wait only a little longer for the others: one slow
  // free model shouldn't hold up the whole answer.
  const enough = new AbortController();
  let grace: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.allSettled(
    models.map(async (m) => {
      const content = await chatComplete(cfg, m, messages, timeoutMs, 0.2, anySignal(signal, enough.signal));
      grace ??= setTimeout(() => enough.abort(), cfg.draftGraceMs);
      return content;
    }),
  );
  clearTimeout(grace);
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { model: models[i], content: r.value }
      : {
        model: models[i],
        content: "",
        error: enough.signal.aborted && !signal?.aborted ? `${models[i]}: slower than the others, not waited for` : String(r.reason),
      },
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
  timeLeft: () => number,
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

  // A fallback checker only gets a try if there's a sensible amount of time left.
  const minTry = Math.min(10_000, cfg.timeLimitMs / 10);
  const errors: string[] = [];
  for (const model of models) {
    if (errors.length && timeLeft() < minTry) break;
    try {
      const raw = await chatComplete(cfg, model, messages, Math.min(cfg.checkerTimeoutMs, timeLeft()), 0.1, signal);
      return { ...parseCheckerOutput(raw, sources.length > 0), model };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(String(err instanceof Error ? err.message : err));
    }
  }
  const draftErrors = drafts.filter((d) => d.error).map((d) => d.error!);
  throw new Error(
    "The AI models didn't respond. Free OpenRouter models are sometimes unavailable or rate-limited \u2014 " +
      "try again shortly, or switch to Paid for this question.\n\nDetails: " +
      [...errors, ...draftErrors].join(" | ").slice(0, 600),
  );
}

/** Shown when the models are too slow to answer within the time limit. */
export function tooSlowMessage(cfg: Config): string {
  return (
    `The AI models didn't finish within ${Math.round(cfg.timeLimitMs / 1000)} seconds, so I stopped waiting. ` +
    "Free models are sometimes slow or busy \u2014 try again in a minute, or switch to Paid for this question."
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

  // Every step shares one deadline, so the answer (or a clear error) is always
  // sent before Supabase cuts the request off.
  const started = Date.now();
  const timeLeft = () => started + cfg.timeLimitMs - Date.now();
  const budget = withTimeout(signal, cfg.timeLimitMs);
  const timings: Record<string, number> = {};
  const lap = (step: string) => (timings[step] = Date.now() - started);

  try {
    emit({ type: "stage", stage: "retrieving" });
    const sources = await retrieve(cfg, question, budget);
    lap("retrieved");
    emit({ type: "sources", sources });

    if (!sources.length) {
      // Deterministic abstention: nothing retrieved, so no model is asked to answer.
      emit({ type: "final", text: ABSTAIN, removed: [], citations: [], quotes: [], checker: "" });
      emit({ type: "done", confidence: "low", unsupported: [] });
      return;
    }

    const set = await resolveModels(cfg, tier, budget);
    const generators = set.generators.slice(0, Math.max(1, cfg.fanout));
    emit({ type: "meta", tier, generators, checker: set.checker[0] ?? "" });

    emit({ type: "stage", stage: "drafting" });
    // Drafting may use just over half the remaining time; the rest is kept for checking.
    const draftMs = Math.min(cfg.generatorTimeoutMs, Math.floor(timeLeft() * 0.55));
    const drafts = await runGenerators(cfg, generators, question, history, sources, draftMs, budget);
    lap("drafted");
    // Credit only the models whose drafts were actually used.
    emit({ type: "meta", tier, generators: drafts.filter((d) => d.content).map((d) => d.model), checker: set.checker[0] ?? "" });

    emit({ type: "stage", stage: "checking" });
    const checked = await runChecker(cfg, set.checker, question, history, sources, drafts, timeLeft, budget);
    lap("checked");
    // Timings and model names only (never the question), for diagnosing slow answers in the logs.
    console.log(JSON.stringify({ event: "answer", tier, ms: timings, drafts: drafts.map((d) => !!d.content), checker: checked.model }));

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
  } catch (err) {
    lap("failed");
    console.log(JSON.stringify({ event: "answer_failed", tier, ms: timings, outOfTime: budget.aborted && !signal?.aborted }));
    throw budget.aborted && !signal?.aborted ? new Error(tooSlowMessage(cfg)) : err;
  }
}
