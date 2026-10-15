/**
 * Answer pipeline (runtime-agnostic: only web-standard fetch/AbortSignal, so it
 * runs under Deno in Supabase Edge Functions and under Node in tests).
 *
 *   1. retrieve  - embed the question (Gemini) and search the document corpus
 *                  (pgvector `match_chunks`). Closed corpus: no web search.
 *   2. draft     - fan the question out to a model ensemble (OpenRouter, and
 *                  for free answers Google's Gemini API, which is much faster).
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
  /** The whole answer must be sent within this; Supabase stops a worker 150s after it starts (free plan). */
  timeLimitMs: number;
  /**
   * Once one draft is in, the longest to wait for the other drafting models
   * (less if the first was quick: see runGenerators).
   */
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
// 2-3. Models (OpenRouter, and Gemini directly)
// ---------------------------------------------------------------------------

type Msg = { role: string; content: string };

interface CatalogModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; output_modalities?: string[] };
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
let catalog: { at: number; models: CatalogModel[] } | null = null;

/** Forget the cached model lists (tests). */
export function clearModelCatalog() {
  catalog = null;
  geminiCache = null;
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

// Models that can't answer a legal question in text: vision, embedding, safety
// classifiers, audio, image and code models, and routers to random free models.
const NOT_CHAT = /[-_]vl\b|vision|embed|guard|safety|audio|tts|image|[-_]code(r)?\b|^openrouter\//i;
// Size words that mark a small model when the name gives no parameter count.
const SMALL_NAME = /\b(nano|mini|small|tiny|lite|lightning|xs)\b/i;
// Large model families whose names don't state their size.
const LARGE_UNSIZED = /deepseek|kimi|glm|gemini/i;

const writesText = (m: CatalogModel) => {
  const out = m.architecture?.output_modalities;
  if (out) return out.includes("text");
  return !m.architecture?.modality || m.architecture.modality.endsWith("->text");
};
const isChat = (m: CatalogModel) => (m.context_length ?? 0) >= 16_000 && !NOT_CHAT.test(m.id) && writesText(m);

/**
 * Rough model size in billions of parameters, from names like "70b" or
 * "120b-a12b" (a mixture of experts, counted between its total and active
 * size); null when the name doesn't say.
 */
export function modelSize(id: string): number | null {
  const m = id.match(/(?:^|[-_:/])(\d+(?:\.\d+)?)b(?:-a(\d+(?:\.\d+)?)b)?(?=$|[-_:.])/i);
  if (m) return Math.round(Math.sqrt(Number(m[1]) * Number(m[2] ?? m[1])) * 10) / 10;
  return LARGE_UNSIZED.test(id) ? 120 : null;
}

/**
 * Free chat models, most capable first. Free models come and go, so this works
 * from the model list alone: large models (25B+) by size, then models whose size
 * isn't known (newest first), then mid-sized ones. Small models are left out:
 * they can't be trusted to check legal answers.
 */
function rankedFree(models: CatalogModel[]): string[] {
  const tier = (size: number | null) => (size === null ? 1 : size >= 25 ? 0 : 2);
  return models
    .filter((m) => isFree(m) && isChat(m))
    .map((m) => ({ m, size: modelSize(m.id) }))
    .filter(({ m, size }) => (size === null ? !SMALL_NAME.test(m.id) : size >= 8))
    .sort((a, b) =>
      tier(a.size) - tier(b.size) || (b.size ?? 0) - (a.size ?? 0) || (b.m.created ?? 0) - (a.m.created ?? 0)
    )
    .map(({ m }) => m.id);
}

const unique = (ids: string[]) => [...new Set(ids)];

// Free models used only if OpenRouter's model list can't be fetched.
const OFFLINE_FREE = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free",
];

// ---------------------------------------------------------------------------
// Gemini, called directly with the Gemini key the app already has for search.
// Google's free Flash models answer in seconds, where free OpenRouter models
// can take minutes. Model names change, so they are read from Google's list.
// ---------------------------------------------------------------------------

/** Model ids starting with this go to Google's Gemini API rather than OpenRouter. */
export const GEMINI_PREFIX = "google-ai-studio/";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiModel {
  id: string; // with GEMINI_PREFIX
  name: string;
  lite: boolean;
}

let geminiCache: { at: number; models: GeminiModel[] } | null = null;

const GEMINI_FLASH = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(?:-(?:preview|exp)[\w-]*)?$/;
const GEMINI_NOT_TEXT = /tts|image|audio|live|thinking|robotics|computer/;

/** Gemini Flash models, newest first, stable releases before previews; Flash-Lite last. */
export function rankedGemini(
  models: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[],
): GeminiModel[] {
  return models
    .map((m) => ({ m, id: String(m.name ?? "").replace(/^models\//, "") }))
    .map(({ m, id }) => ({ m, id, match: id.match(GEMINI_FLASH) }))
    .filter(({ m, id, match }) =>
      match && !GEMINI_NOT_TEXT.test(id) && (m.supportedGenerationMethods ?? []).includes("generateContent")
    )
    .map(({ m, id, match }) => ({
      id,
      name: m.displayName || id,
      version: Number(match![1]),
      lite: Boolean(match![2]),
      preview: /-(preview|exp)/.test(id),
    }))
    .sort((a, b) =>
      Number(a.lite) - Number(b.lite) || b.version - a.version || Number(a.preview) - Number(b.preview) ||
      a.id.localeCompare(b.id)
    )
    .map(({ id, name, lite }) => ({ id: GEMINI_PREFIX + id, name, lite }));
}

/** The Gemini Flash models this key can use (cached for an hour); [] if they can't be listed. */
async function geminiModels(cfg: Config, signal?: AbortSignal): Promise<GeminiModel[]> {
  if (!cfg.geminiKey) return [];
  if (geminiCache && Date.now() - geminiCache.at < CATALOG_TTL_MS) return geminiCache.models;
  try {
    const res = await fetch(`${GEMINI_API}/models?pageSize=1000`, {
      headers: { "x-goog-api-key": cfg.geminiKey },
      signal: withTimeout(signal, 10_000),
    });
    const data = res.ok ? await res.json() : null;
    if (!res.ok) await res.body?.cancel();
    if (!Array.isArray(data?.models)) return geminiCache?.models ?? [];
    geminiCache = { at: Date.now(), models: rankedGemini(data.models) };
    return geminiCache.models;
  } catch {
    return geminiCache?.models ?? [];
  }
}

/** Thinking makes answers slower: keep it low (Gemini 3 and later) or off (2.5). */
function geminiThinking(id: string): Record<string, unknown> | undefined {
  const version = Number(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  if (version >= 3) return { thinkingLevel: "low" };
  if (version >= 2.5) return { thinkingBudget: 0 };
  return undefined;
}

async function geminiComplete(
  cfg: Config,
  model: string,
  messages: Msg[],
  timeoutMs: number,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const id = model.slice(GEMINI_PREFIX.length);
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const deadline = withTimeout(signal, timeoutMs);
  const send = (thinking?: Record<string, unknown>) =>
    fetch(`${GEMINI_API}/models/${id}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": cfg.geminiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature, ...(thinking ? { thinkingConfig: thinking } : {}) },
      }),
      signal: deadline,
    });

  const thinking = geminiThinking(id);
  let res = await send(thinking);
  if (res.status === 400 && thinking) {
    const text = await errorText(res);
    if (!/thinking/i.test(text)) throw new Error(`${model}: HTTP 400 ${text}`);
    res = await send(); // a model that doesn't take this thinking setting
  }
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await errorText(res)}`);
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const parts: { text?: unknown; thought?: unknown }[] = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts
    : [];
  const content = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!content.trim()) {
    const why = candidate?.finishReason ?? data?.promptFeedback?.blockReason;
    throw new Error(`${model}: empty response${why ? ` (${why})` : ""}`);
  }
  return content;
}

/**
 * The models to use for a tier, checked against the live model lists:
 * models chosen on the Settings page (or by secrets) that are still offered,
 * and for the free tier still free, come first, then the best other
 * candidates. Free slugs come and go, so this keeps the app answering without
 * a redeploy.
 *
 * Free answers draft with one Gemini model (Flash-Lite where available: fast,
 * with the largest free allowance) alongside OpenRouter models, and are
 * checked by Gemini Flash, falling back to other Gemini models, then
 * OpenRouter's. A used-up Gemini allowance is refused at once, so falling
 * back costs little time.
 */
export async function resolveModels(cfg: Config, tier: Tier, signal?: AbortSignal): Promise<ModelSet> {
  const configured = cfg.models[tier];
  if (tier === "free") {
    const [models, gemini] = await Promise.all([modelCatalog(cfg, signal), geminiModels(cfg, signal)]);
    const free = new Set(models?.filter(isFree).map((m) => m.id));
    const offered = new Set(gemini.map((g) => g.id));
    // If OpenRouter's list can't be fetched, chosen OpenRouter models are used as they are.
    const usable = (id: string) => id.startsWith(GEMINI_PREFIX) ? offered.has(id) : !models || free.has(id);
    const openrouter = models ? rankedFree(models) : OFFLINE_FREE;
    const lite = gemini.filter((g) => g.lite).map((g) => g.id);
    const flash = gemini.filter((g) => !g.lite).map((g) => g.id);
    return {
      // Drafting count is set by cfg.fanout (runPipeline).
      generators: unique([...configured.generators.filter(usable), ...[...lite, ...flash].slice(0, 1), ...openrouter]),
      checker: unique([...configured.checker.filter(usable), ...[...flash, ...lite].slice(0, 3), ...openrouter])
        .slice(0, 5),
    };
  }

  const models = await modelCatalog(cfg, signal);
  if (!models) return configured;
  const offered = new Set(models.filter((m) => !isFree(m)).map((m) => m.id));
  const fallbacks = models
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

/**
 * Choices for the Settings page: free models (Gemini's first, then OpenRouter
 * chat models that are free right now), and paid ones from major providers.
 */
export async function modelOptions(
  cfg: Config,
  signal?: AbortSignal,
): Promise<{ free: ModelOption[]; paid: ModelOption[] } | null> {
  const [models, gemini] = await Promise.all([modelCatalog(cfg, signal), geminiModels(cfg, signal)]);
  if (!models && !gemini.length) return null;
  const option = (m: CatalogModel): ModelOption => ({ id: m.id, name: m.name || m.id, context: m.context_length });
  return {
    free: [
      ...gemini.map((g) => ({ id: g.id, name: `Google: ${g.name} (direct, with your Gemini key)` })),
      ...(models ?? [])
        .filter((m) => isFree(m) && isChat(m))
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
        .map(option),
    ],
    paid: (models ?? [])
      .filter((m) => !isFree(m) && isChat(m) && PAID_PROVIDERS.test(m.id))
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
  if (model.startsWith(GEMINI_PREFIX)) return await geminiComplete(cfg, model, messages, timeoutMs, temperature, signal);
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
  // free model shouldn't hold up the whole answer. After a quick first draft,
  // wait about as long again (at least a third of the full grace period).
  const enough = new AbortController();
  const started = Date.now();
  let grace: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.allSettled(
    models.map(async (m) => {
      const content = await chatComplete(cfg, m, messages, timeoutMs, 0.2, anySignal(signal, enough.signal));
      const wait = Math.min(cfg.draftGraceMs, Math.max(cfg.draftGraceMs / 3, Date.now() - started));
      grace ??= setTimeout(() => enough.abort(), wait);
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

  // A fallback checker only gets a try if there's a sensible amount of time left,
  // so all but the last checker may use at most 70% of it. (The last one runs to
  // the overall deadline, which arrives via `signal`.) Running out of time is
  // always reported as such.
  const minTry = Math.min(10_000, cfg.timeLimitMs / 10);
  const errors: string[] = [];
  for (const [i, model] of models.entries()) {
    if (errors.length && timeLeft() < minTry) throw new Error(tooSlowMessage(cfg));
    const last = i === models.length - 1;
    const timeout = last ? cfg.checkerTimeoutMs : Math.min(cfg.checkerTimeoutMs, Math.floor(timeLeft() * 0.7));
    try {
      const raw = await chatComplete(cfg, model, messages, timeout, 0.1, signal);
      return { ...parseCheckerOutput(raw, sources.length > 0), model };
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push(String(err instanceof Error ? err.message : err));
    }
  }
  const draftErrors = drafts.filter((d) => d.error).map((d) => d.error!);
  throw new Error(
    "The AI models didn't respond. Free models are sometimes unavailable or out of their daily allowance \u2014 " +
      "try again shortly, or switch to Paid for this question.\n\nDetails: " +
      [...errors, ...draftErrors].join(" | ").slice(0, 600),
  );
}

/** Shown when the models are too slow to answer within the time limit. */
export function tooSlowMessage(cfg: Config): string {
  const seconds = Math.round(cfg.timeLimitMs / 1000);
  return (
    `The AI models didn't finish within ${seconds} second${seconds === 1 ? "" : "s"}, so I stopped waiting. ` +
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
    console.log(JSON.stringify({
      event: "answer",
      tier,
      limit: cfg.timeLimitMs,
      ms: timings,
      drafts: Object.fromEntries(drafts.map((d) => [d.model, !!d.content])),
      checker: checked.model,
    }));

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
    console.log(JSON.stringify({
      event: "answer_failed",
      tier,
      limit: cfg.timeLimitMs,
      ms: timings,
      outOfTime: budget.aborted && !signal?.aborted,
    }));
    throw budget.aborted && !signal?.aborted ? new Error(tooSlowMessage(cfg)) : err;
  }
}
