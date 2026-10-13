/**
 * research-api - Supabase Edge Function backing the GitHub Pages site.
 *
 * Routes (all under /functions/v1/research-api):
 *   GET  /health         - which keys are configured (no auth, booleans only)
 *   GET  /me             - is this caller allowed? (the site checks before showing the app)
 *   GET  /documents      - document list + the loader's last run   (auth required)
 *   GET  /settings       - Settings page data; never key values    (auth required)
 *   PUT  /settings       - save AI settings (app-wide)             (auth required)
 *   PUT  /settings/keys  - save/remove an API key in Vault         (auth required)
 *   POST /chat           - NDJSON stream of pipeline events        (auth required)
 *
 * Auth: the caller must send a Supabase Auth session token for a user whose
 * email is in the ALLOWED_EMAILS secret. Verified here via /auth/v1/user rather
 * than the gateway's verify_jwt (deployed with verify_jwt=false) because CORS
 * preflights carry no token and the gateway would reject them. The project's
 * service key is also accepted, so the live smoke test (scripts/smoke.mjs, run
 * by GitHub Actions) can exercise the real pipeline; that key already grants
 * full database access, so accepting it here grants nothing new.
 *
 * Secrets (Supabase -> Edge Functions -> Secrets):
 *   ALLOWED_EMAILS (comma-separated), and OPENROUTER_API_KEY / GEMINI_API_KEY
 *   unless they're entered on the Settings page (which then takes precedence).
 * SUPABASE_URL and the service-role key are injected automatically.
 */

import {
  ConfigError,
  modelOptions,
  resolveModels,
  runPipeline,
  serviceHeaders,
  type ChatMessage,
  type Config,
  type StreamEvent,
  type Tier,
} from "./pipeline.ts";
import {
  DEFAULT_AI,
  KEY_NAMES,
  keyHint,
  loadSettings,
  saveAi,
  storedKey,
  storeKey,
  testKey,
  validateAi,
  type AiSettings,
  type KeyName,
  type LibraryStatus,
} from "./settings.ts";

type DenoRuntime = { env: { get(name: string): string | undefined }; serve?: (h: typeof handler) => unknown };
// Accessed via globalThis so the module also loads under Node for tests.
const runtime = () => (globalThis as unknown as { Deno?: DenoRuntime }).Deno;

function env(name: string): string | undefined {
  const v = runtime()?.env.get(name);
  return v && v.trim() ? v.trim() : undefined;
}

function list(name: string, fallback: string[]): string[] {
  const items = (env(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function num(name: string, fallback: number): number {
  const n = Number(env(name));
  return Number.isFinite(n) && env(name) !== undefined ? n : fallback;
}

/** First string value of a JSON object secret (SUPABASE_SECRET_KEYS / _PUBLISHABLE_KEYS). */
function firstKey(name: string): string | undefined {
  const raw = env(name);
  if (!raw) return undefined;
  try {
    const v = Object.values(JSON.parse(raw)).find((x) => typeof x === "string");
    return v as string | undefined;
  } catch {
    return undefined;
  }
}

const supabaseUrl = () => env("SUPABASE_URL") ?? "";
const serviceKey = () => env("SUPABASE_SERVICE_ROLE_KEY") ?? firstKey("SUPABASE_SECRET_KEYS") ?? "";
const publicKey = () => env("SUPABASE_ANON_KEY") ?? firstKey("SUPABASE_PUBLISHABLE_KEYS") ?? serviceKey();

// Free OpenRouter slugs come and go: these are preferences, checked against
// OpenRouter's live list at question time (pipeline.ts resolveModels).
const DEFAULT_FREE_GENERATORS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free",
];
const DEFAULT_FREE_CHECKER = ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat-v3-0324:free"];
const DEFAULT_PAID_GENERATORS = ["anthropic/claude-sonnet-4.5"];
const DEFAULT_PAID_CHECKER = ["anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4", "anthropic/claude-3.7-sonnet"];

const unique = (ids: string[]) => [...new Set(ids)];

type KeySource = "settings" | "supabase" | "missing";

/** A key saved on the Settings page wins over the Supabase secret. */
async function effectiveKey(name: KeyName): Promise<{ value?: string; source: KeySource }> {
  const stored = await storedKey(supabaseUrl(), serviceKey(), name);
  if (stored) return { value: stored, source: "settings" };
  const secret = env(name === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY");
  return secret ? { value: secret, source: "supabase" } : { source: "missing" };
}

/** Settings-page choices for anyone who hasn't saved any yet: secrets, then built-in defaults. */
function defaultAi(): AiSettings {
  return { ...DEFAULT_AI, fanout: num("FANOUT", DEFAULT_AI.fanout), topK: num("RETRIEVAL_TOP_K", DEFAULT_AI.topK) };
}

/**
 * Everything a request needs. Precedence: the Settings page, then Supabase
 * secrets, then built-in defaults.
 */
async function load(): Promise<{ cfg: Config; ai: AiSettings; library: LibraryStatus }> {
  const [{ ai: saved, library }, openrouter, gemini] = await Promise.all([
    loadSettings(supabaseUrl(), serviceKey()),
    effectiveKey("openrouter"),
    effectiveKey("gemini"),
  ]);
  const ai = saved ?? defaultAi();
  const freeChecker = list("FREE_CHECKER", DEFAULT_FREE_CHECKER);
  const paidChecker = list("PAID_CHECKER", DEFAULT_PAID_CHECKER);
  const cfg: Config = {
    supabaseUrl: supabaseUrl(),
    serviceKey: serviceKey(),
    openrouterKey: openrouter.value,
    geminiKey: gemini.value,
    embedModel: env("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-001",
    embedDim: num("EMBEDDING_DIM", 1024),
    topK: ai.topK,
    minSimilarity: num("MIN_SIMILARITY", 0),
    snippetChars: num("SNIPPET_CHARS", 3500),
    fanout: ai.fanout,
    models: {
      free: {
        generators: unique([...ai.freeModels, ...list("FREE_GENERATORS", DEFAULT_FREE_GENERATORS)]),
        checker: unique([...(ai.freeChecker ? [ai.freeChecker] : []), ...freeChecker]),
      },
      paid: {
        generators: ai.paidModel ? [ai.paidModel] : list("PAID_GENERATORS", DEFAULT_PAID_GENERATORS),
        checker: ai.paidModel ? unique([ai.paidModel, ...paidChecker]) : paidChecker,
      },
    },
    appUrl: env("APP_URL") ?? "https://learner-agent-sudo.github.io/research-fact-base/",
    generatorTimeoutMs: num("GENERATOR_TIMEOUT_MS", 50_000),
    checkerTimeoutMs: num("CHECKER_TIMEOUT_MS", 80_000),
    // Supabase stops a request at 150s (free plan); leave room to send the result.
    timeLimitMs: num("TIME_LIMIT_MS", 120_000),
    draftGraceMs: num("DRAFT_GRACE_MS", 15_000),
  };
  return { cfg, ai, library };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

// Auth is a bearer token, not a cookie, so an open CORS policy grants nothing
// to other sites: they can't obtain a user's token.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Identity returned for callers holding the project's service key (the live smoke test). */
export const SERVICE_CALLER = "service-key";

/** Every server-side key of this project: the legacy service_role JWT and any new sb_secret_ keys. */
function serviceKeys(): string[] {
  const keys: unknown[] = [env("SUPABASE_SERVICE_ROLE_KEY")];
  try {
    keys.push(...Object.values(JSON.parse(env("SUPABASE_SECRET_KEYS") ?? "{}")));
  } catch {
    // not set / not JSON
  }
  return keys.filter((k): k is string => typeof k === "string" && k !== "");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True if `token` is a service-level key for this project. Checked against the
 * injected keys first; failing that, by asking Auth's admin API to accept it, so
 * either key format works whichever one is stored in the GitHub secret.
 */
async function isServiceKey(token: string): Promise<boolean> {
  if (serviceKeys().some((k) => sameString(k, token))) return true;
  if (!/^(sb_secret_|eyJ)/.test(token)) return false;
  const headers: Record<string, string> = { apikey: token };
  if (token.startsWith("eyJ")) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users?page=1&per_page=1`, { headers });
  await res.body?.cancel();
  return res.ok;
}

/**
 * Returns the caller's identity (an allowlisted email, or SERVICE_CALLER), or an
 * error Response to send back.
 */
async function authorize(req: Request): Promise<string | Response> {
  const token = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return json({ error: "Not signed in." }, 401);
  if (serviceKeys().some((k) => sameString(k, token))) return SERVICE_CALLER;

  const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: publicKey(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    await res.body?.cancel();
    if (await isServiceKey(token)) return SERVICE_CALLER;
    return json({ error: "Your session has expired. Please sign in again." }, 401);
  }
  const email = String((await res.json())?.email ?? "").toLowerCase();

  const allowed = list("ALLOWED_EMAILS", []).map((e) => e.toLowerCase());
  if (!allowed.length) {
    return json(
      {
        error:
          "The server has no ALLOWED_EMAILS configured, so nobody can use the app yet. " +
          "Add your email in Supabase \u2192 Edge Functions \u2192 Secrets \u2192 ALLOWED_EMAILS.",
      },
      503,
    );
  }
  if (!email || !allowed.includes(email)) {
    return json(
      {
        error:
          `${email || "This account"} is not on the allowed list. Sign in with an allowed email, or add ` +
          "this one to ALLOWED_EMAILS in Supabase \u2192 Edge Functions \u2192 Secrets.",
      },
      403,
    );
  }
  return email;
}

function parseChat(body: unknown): { messages: ChatMessage[]; tier: Tier } | null {
  const b = body as { messages?: unknown; tier?: unknown } | null;
  const raw = Array.isArray(b?.messages) ? b!.messages : [];
  const messages: ChatMessage[] = raw
    .filter(
      (m: { role?: unknown; content?: unknown }) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-12)
    .map((m: { role: "user" | "assistant"; content: string }) => ({
      role: m.role,
      content: m.content.slice(0, 8000),
    }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return { messages, tier: b?.tier === "paid" ? "paid" : "free" };
}

function chatStream(req: Request, messages: ChatMessage[], tier: Tier): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (ev: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          open = false; // client went away
        }
      };
      // Keep the connection visibly alive while models think.
      const ping = setInterval(() => emit({ type: "ping" }), 10_000);
      try {
        const { cfg } = await load();
        await runPipeline(cfg, messages, tier, emit, req.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof ConfigError)) console.error("pipeline error:", message);
        emit({ type: "error", message });
      } finally {
        clearInterval(ping);
        open = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(body, {
    headers: {
      ...CORS,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

async function documents(): Promise<Response> {
  const base = supabaseUrl();
  const headers = serviceHeaders(serviceKey());
  const [docs, count, { library }] = await Promise.all([
    fetch(
      `${base}/rest/v1/documents?select=id,title,mime_type,status,drive_file_id,drive_modified_at,created_at&order=title.asc`,
      { headers },
    ),
    fetch(`${base}/rest/v1/chunks?select=id&embedding=not.is.null&limit=1`, {
      headers: { ...headers, Prefer: "count=exact" },
    }),
    loadSettings(base, serviceKey()),
  ]);
  if (!docs.ok) return json({ error: `Could not load documents (HTTP ${docs.status}).` }, 502);
  const total = (count.headers.get("content-range") ?? "").split("/")[1];
  return json({ documents: await docs.json(), embeddedChunks: Number(total) || 0, library });
}

/** What the Settings page shows. Key values are never included, only where each comes from. */
async function settingsView(): Promise<Response> {
  const { cfg, ai } = await load();
  const [keys, options, free, paid] = await Promise.all([
    Promise.all(KEY_NAMES.map(async (name) => {
      const k = await effectiveKey(name);
      return [name, { source: k.source, hint: k.value ? keyHint(k.value) : null }] as const;
    })),
    cfg.openrouterKey ? modelOptions(cfg) : Promise.resolve(null),
    resolveModels(cfg, "free"),
    resolveModels(cfg, "paid"),
  ]);
  return json({
    ai,
    keys: Object.fromEntries(keys),
    models: {
      options,
      current: {
        free: { generators: free.generators.slice(0, Math.max(1, cfg.fanout)), checker: free.checker[0] ?? "" },
        paid: { generators: paid.generators.slice(0, 1), checker: paid.checker[0] ?? "" },
      },
    },
  });
}

async function saveSettings(req: Request, who: string): Promise<Response> {
  const body = await req.json().catch(() => null);
  const ai = validateAi(body?.ai);
  if (typeof ai === "string") return json({ error: ai }, 400);
  await saveAi(supabaseUrl(), serviceKey(), ai, who);
  return await settingsView();
}

async function saveKey(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { name?: unknown; value?: unknown } | null;
  const name = body?.name as KeyName;
  if (!KEY_NAMES.includes(name)) return json({ error: "Unknown key." }, 400);
  if (body?.value === null) {
    await storeKey(supabaseUrl(), serviceKey(), name, null);
    return json({ ok: true });
  }
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (value.length < 10 || value.length > 300 || /\s/.test(value)) {
    return json({ error: "That doesn't look like a complete key. Paste the whole key, with no spaces." }, 400);
  }
  const problem = await testKey(name, value, env("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-001", num("EMBEDDING_DIM", 1024));
  if (problem) return json({ error: problem }, 400);
  await storeKey(supabaseUrl(), serviceKey(), name, value);
  return json({ ok: true });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // "/functions/v1/research-api/settings/keys" -> "/settings/keys"
  const path = new URL(req.url).pathname.replace(/^.*?\/research-api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const route = `${req.method} ${path}`;

  try {
    if (route === "GET /health") {
      const [openrouter, gemini] = await Promise.all([effectiveKey("openrouter"), effectiveKey("gemini")]);
      return json({
        ok: true,
        configured: {
          supabase: Boolean(supabaseUrl() && serviceKey()),
          openrouter: Boolean(openrouter.value),
          gemini: Boolean(gemini.value),
          allowedEmails: list("ALLOWED_EMAILS", []).length > 0,
        },
      });
    }

    const routes: Record<string, (who: string) => Promise<Response>> = {
      "GET /me": async (who) => {
        const { ai } = await loadSettings(supabaseUrl(), serviceKey());
        return json({
          email: who === SERVICE_CALLER ? null : who,
          service: who === SERVICE_CALLER,
          defaultTier: (ai ?? defaultAi()).defaultTier,
        });
      },
      "GET /documents": () => documents(),
      "GET /settings": () => settingsView(),
      "PUT /settings": (who) => saveSettings(req, who),
      "PUT /settings/keys": () => saveKey(req),
      "POST /chat": async () => {
        const parsed = parseChat(await req.json().catch(() => null));
        if (!parsed) return json({ error: "Expected a question." }, 400);
        return chatStream(req, parsed.messages, parsed.tier);
      },
    };
    const run = routes[route];
    if (!run) return json({ error: "Not found." }, 404);
    const who = await authorize(req);
    if (who instanceof Response) return who;
    return await run(who);
  } catch (err) {
    console.error("request error:", err instanceof Error ? err.message : String(err));
    return json({ error: "Internal error." }, 500);
  }
}

runtime()?.serve?.(handler);
