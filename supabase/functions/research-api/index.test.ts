// End-to-end test of the edge function's HTTP handler with every external
// service (Supabase Auth/REST, Gemini, OpenRouter) simulated via fetch.
// Run: npm run test:edge
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const ENV: Record<string, string | undefined> = {};
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => ENV[k] } };

function resetEnv() {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, {
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "eyJservice",
    SUPABASE_ANON_KEY: "eyJanon",
    OPENROUTER_API_KEY: "or-key",
    GEMINI_API_KEY: "gem-key",
    ALLOWED_EMAILS: "Owner@Example.com, colleague@example.com",
  });
}

const ROWS = [
  {
    content:
      "In Bhasin v Hrynew, 2014 SCC 71, the Court recognized a general organizing principle of good faith, " +
      "and a duty of honest performance in contractual dealings.",
    title: "Contract Case List 2024.md",
    drive_file_id: "abc123",
    similarity: 0.82,
  },
];

const CHECKER_OUTPUT =
  "There is a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1]. " +
  "It was extended in Callow v Zollinger, 2020 SCC 45 [S1].\n" +
  '<<<META>>>{"confidence":"high","unsupported":[],"quotes":[{"source":"S1","text":"a duty of honest performance in contractual dealings"}]}';

interface Scenario {
  user?: { email: string } | null;
  rows?: unknown[];
  checkerFailsFirst?: boolean;
  /** OpenRouter's model list; unset = the list can't be fetched. */
  catalog?: { id: string; created?: number; context_length?: number; pricing?: { prompt: string; completion: string } }[];
}
let scenario: Scenario = {};
/** Simulated database state: app_settings rows and Vault secrets. */
let db: { appSettings: Record<string, unknown>; vault: Record<string, string> } = { appSettings: {}, vault: {} };
const VALID_OR_KEY = "sk-or-v1-valid-key-1234567890";
const BAD_GEMINI_KEY = "AIza-revoked-key-000000000";
let calls: { url: string; body?: unknown; headers: Record<string, string> }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ url, body, headers });
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

  if (url.endsWith("/auth/v1/user")) {
    return scenario.user ? reply(scenario.user) : reply({ msg: "bad jwt" }, 401);
  }
  if (url.includes("/auth/v1/admin/users")) {
    // Auth's admin API accepts only the project's real service keys.
    return headers.apikey === "sb_secret_from_github" ? reply({ users: [] }) : reply({ msg: "not admin" }, 401);
  }
  if (url.includes("/rest/v1/app_settings")) {
    if (init?.method === "POST") {
      const row = body as { key: string; value: unknown };
      db.appSettings[row.key] = row.value;
      return new Response(null, { status: 201 });
    }
    return reply(Object.entries(db.appSettings).map(([key, value]) => ({ key, value })));
  }
  if (url.endsWith("/rpc/app_secret_get")) {
    return reply(db.vault[(body as { p_name: string }).p_name] ?? null);
  }
  if (url.endsWith("/rpc/app_secret_set")) {
    const { p_name, p_value } = body as { p_name: string; p_value: string | null };
    if (p_value) db.vault[p_name] = p_value;
    else delete db.vault[p_name];
    return new Response(null, { status: 204 });
  }
  if (url === "https://openrouter.ai/api/v1/key") {
    return headers.Authorization === `Bearer ${VALID_OR_KEY}` ? reply({ data: {} }) : reply({ error: "No auth" }, 401);
  }
  if (url.includes(":embedContent") && headers["x-goog-api-key"] === BAD_GEMINI_KEY) {
    return reply({ error: { message: "API key not valid. Please pass a valid API key.", status: "API_KEY_INVALID" } }, 400);
  }
  if (url.includes(":embedContent")) {
    return reply({ embedding: { values: Array.from({ length: 1024 }, (_, i) => (i % 7) / 7) } });
  }
  if (url.endsWith("/rpc/match_chunks")) return reply(scenario.rows ?? ROWS);
  if (url.includes("/rest/v1/documents")) {
    return reply([{ id: "d1", title: "Contract Case List 2024.md", mime_type: "text/markdown", status: "ready" }]);
  }
  if (url.includes("/rest/v1/chunks")) return reply([{ id: "c1" }], 200, { "content-range": "0-0/999" });
  if (url === "https://openrouter.ai/api/v1/models") {
    return scenario.catalog ? reply({ data: scenario.catalog }) : reply({ error: "unavailable" }, 503);
  }
  if (url.includes("openrouter.ai")) {
    const system = (body as { messages: { content: string }[] }).messages[0].content;
    const isChecker = system.startsWith("You are a strict verifier");
    if (isChecker) {
      const priorCheckerCalls = calls.filter(
        (c) => c.url.endsWith("/chat/completions") &&
          (c.body as { messages: { content: string }[] }).messages[0].content.startsWith("You are a strict verifier"),
      ).length;
      if (scenario.checkerFailsFirst && priorCheckerCalls === 1) return reply({ error: "overloaded" }, 503);
      return reply({ choices: [{ message: { content: CHECKER_OUTPUT } }] });
    }
    return reply({ choices: [{ message: { content: "draft answer [S1]" } }] });
  }
  return reply({ error: `unexpected ${url}` }, 500);
}) as typeof fetch;

const { handler } = await import("./index.ts");
const { clearModelCatalog } = await import("./pipeline.ts");
const completions = () => calls.filter((c) => c.url.endsWith("/chat/completions"));

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== "ping");
}

const get = (route: string, token = "user-jwt") =>
  handler(
    new Request(`https://proj.supabase.co/functions/v1/research-api/${route}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

const chat = (body: unknown, token = "user-jwt") =>
  handler(
    new Request("https://proj.supabase.co/functions/v1/research-api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  clearModelCatalog();
  db = { appSettings: {}, vault: {} };
  resetEnv();
  scenario = { user: { email: "owner@example.com" } };
  calls = [];
});

test("CORS preflight succeeds without a token", async () => {
  const res = await handler(new Request("https://p/functions/v1/research-api/chat", { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("health reports configuration without exposing secrets", async () => {
  const res = await handler(new Request("https://p/functions/v1/research-api/health"));
  const data = await res.json();
  assert.deepEqual(data.configured, { supabase: true, openrouter: true, gemini: true, allowedEmails: true });
  assert.ok(!JSON.stringify(data).includes("or-key"));
});

test("rejects requests without a session token", async () => {
  const res = await chat({ messages: [{ role: "user", content: "q" }] }, "");
  assert.equal(res.status, 401);
});

test("rejects signed-in users who are not on the allowlist", async () => {
  scenario.user = { email: "stranger@example.com" };
  const res = await chat({ messages: [{ role: "user", content: "q" }] });
  assert.equal(res.status, 403);
});

test("/me confirms an allowlisted user (email matched case-insensitively)", async () => {
  scenario.user = { email: "OWNER@example.com" };
  const res = await get("me");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "owner@example.com", service: false, defaultTier: "free" });
});

test("/me tells a signed-in stranger which account is not allowed", async () => {
  scenario.user = { email: "stranger@example.com" };
  const res = await get("me");
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /stranger@example\.com is not on the allowed list/);
});

test("/me rejects missing and expired sessions with 401", async () => {
  assert.equal((await get("me", "")).status, 401);
  scenario.user = null;
  const res = await get("me", "eyJexpired");
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /sign in again/);
});

test("the injected service key is accepted without calling Auth (smoke test caller)", async () => {
  scenario.user = null;
  const res = await get("me", "eyJservice");
  assert.deepEqual(await res.json(), { email: null, service: true, defaultTier: "free" });
  assert.equal(calls.filter((c) => c.url.includes("/auth/v1/")).length, 0);
});

test("/me reports the default answer mode chosen on the Settings page", async () => {
  db.appSettings.ai = { defaultTier: "paid" };
  assert.equal((await (await get("me")).json()).defaultTier, "paid");
});

test("a new-format secret key listed in SUPABASE_SECRET_KEYS is accepted", async () => {
  scenario.user = null;
  ENV.SUPABASE_SECRET_KEYS = JSON.stringify({ default: "sb_secret_abc" });
  assert.equal((await get("me", "sb_secret_abc")).status, 200);
});

test("a service key not injected into the function is verified with Auth's admin API", async () => {
  scenario.user = null;
  const ok = await get("me", "sb_secret_from_github");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).service, true);
  const forged = await get("me", "sb_secret_forged");
  assert.equal(forged.status, 401);
});

test("the service key can run the full pipeline even before ALLOWED_EMAILS is set", async () => {
  delete ENV.ALLOWED_EMAILS;
  scenario.user = null;
  const evs = await events(await chat({ messages: [{ role: "user", content: "duty of good faith?" }] }, "eyJservice"));
  assert.ok(evs.some((e) => e.type === "final"));
});

test("fails closed when ALLOWED_EMAILS is not configured", async () => {
  delete ENV.ALLOWED_EMAILS;
  const res = await chat({ messages: [{ role: "user", content: "q" }] });
  assert.equal(res.status, 503);
});

test("full pipeline: grounded answer, fabricated citation removed before sending", async () => {
  const res = await chat({ messages: [{ role: "user", content: "What is the duty of good faith?" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);
  const evs = await events(res);

  assert.deepEqual(
    evs.map((e) => (e.type === "stage" ? `stage:${e.stage}` : e.type)),
    ["stage:retrieving", "sources", "meta", "stage:drafting", "stage:checking", "stage:verifying", "final", "done"],
  );
  const final = evs.find((e) => e.type === "final") as { text: string; removed: unknown[]; quotes: { status: string }[] };
  assert.equal(final.text, "There is a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1].");
  assert.equal(final.removed.length, 1);
  assert.equal(final.quotes[0].status, "verified");

  const done = evs.find((e) => e.type === "done") as { confidence: string; unsupported: string[] };
  assert.equal(done.confidence, "medium", "capped because a sentence was removed");

  // No unverified text was ever streamed: the only answer text is in "final".
  assert.ok(!evs.some((e) => e.type === "delta"));
  // Three generators + one checker call.
  assert.equal(completions().length, 4);
  // Service role key used for the vector search, sent to Supabase only.
  const search = calls.find((c) => c.url.endsWith("/rpc/match_chunks"))!;
  assert.equal((search.body as { match_count: number }).match_count, 8);
});

test("abstains without calling any model when nothing relevant is retrieved", async () => {
  scenario.rows = [];
  const evs = await events(await chat({ messages: [{ role: "user", content: "Unrelated?" }] }));
  const final = evs.find((e) => e.type === "final") as { text: string };
  assert.match(final.text, /don't contain anything relevant/);
  assert.equal(completions().length, 0);
});

test("missing model key is reported plainly, not as 'no information found'", async () => {
  delete ENV.OPENROUTER_API_KEY;
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const err = evs.find((e) => e.type === "error") as { message: string };
  assert.match(err.message, /OPENROUTER_API_KEY/);
});

test("checker falls back to the next model when the first is unavailable", async () => {
  scenario.checkerFailsFirst = true;
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const final = evs.find((e) => e.type === "final") as { checker: string };
  assert.equal(final.checker, "deepseek/deepseek-chat-v3-0324:free");
});

const FREE = { prompt: "0", completion: "0" };
const PAID = { prompt: "0.000003", completion: "0.000015" };

test("free tier switches to models that are still free when configured ones are withdrawn", async () => {
  scenario.catalog = [
    // Configured slugs, no longer free (the live failure this guards against).
    { id: "meta-llama/llama-3.3-70b-instruct", pricing: PAID, context_length: 131072 },
    { id: "deepseek/deepseek-chat-v3-0324", pricing: PAID, context_length: 163840 },
    { id: "openai/gpt-oss-120b:free", pricing: FREE, context_length: 131072, created: 5 },
    { id: "google/gemini-2.0-flash-exp:free", pricing: FREE, context_length: 1048576, created: 3 },
    { id: "qwen/qwen3-235b-a22b:free", pricing: FREE, context_length: 131072, created: 4 },
    { id: "deepseek/deepseek-chat-v3.1:free", pricing: FREE, context_length: 163840, created: 6 },
    // Skipped: too small, not a chat model, too little context.
    { id: "meta-llama/llama-3.2-3b-instruct:free", pricing: FREE, context_length: 131072, created: 9 },
    { id: "qwen/qwen2.5-vl-72b-instruct:free", pricing: FREE, context_length: 131072, created: 9 },
    { id: "mistralai/mistral-small:free", pricing: FREE, context_length: 8192, created: 9 },
  ];
  const evs = await events(await chat({ messages: [{ role: "user", content: "duty of good faith?" }] }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[]; checker: string };
  assert.deepEqual(meta.generators, [
    "deepseek/deepseek-chat-v3.1:free",
    "qwen/qwen3-235b-a22b:free",
    "google/gemini-2.0-flash-exp:free",
  ]);
  assert.equal(meta.checker, "deepseek/deepseek-chat-v3.1:free");
  assert.ok(evs.some((e) => e.type === "final"));
  const used = completions().map((c) => (c.body as { model: string }).model);
  assert.ok(used.every((m) => m.endsWith(":free")), `only free models called: ${used}`);
});

test("configured free models that are still free keep their place", async () => {
  scenario.catalog = [
    { id: "qwen/qwen-2.5-72b-instruct:free", pricing: FREE, context_length: 32768 },
    { id: "deepseek/deepseek-chat-v3.1:free", pricing: FREE, context_length: 163840 },
  ];
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[] };
  assert.deepEqual(meta.generators, ["qwen/qwen-2.5-72b-instruct:free", "deepseek/deepseek-chat-v3.1:free"]);
});

test("paid tier falls back to the newest Claude Sonnet and still drafts with one model", async () => {
  scenario.catalog = [
    { id: "anthropic/claude-sonnet-4", pricing: PAID, created: 1 },
    { id: "anthropic/claude-sonnet-4.6", pricing: PAID, created: 3 },
    { id: "anthropic/claude-opus-4.6", pricing: PAID, created: 4 },
  ];
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }], tier: "paid" }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[]; checker: string };
  // The configured drafting model (sonnet-4.5) is gone: newest Sonnet, still just one.
  assert.deepEqual(meta.generators, ["anthropic/claude-sonnet-4.6"]);
  // The checker list's own fallback (sonnet-4) is still offered, so it's kept first.
  assert.equal(meta.checker, "anthropic/claude-sonnet-4");
});

test("uses the configured models as-is when OpenRouter's model list is unavailable", async () => {
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[] };
  assert.equal(meta.generators[0], "meta-llama/llama-3.3-70b-instruct:free");
});

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

const put = (route: string, body: unknown, token = "user-jwt") =>
  handler(
    new Request(`https://proj.supabase.co/functions/v1/research-api/${route}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("CORS preflight allows PUT (the Settings page saves with PUT)", async () => {
  const res = await handler(new Request("https://p/functions/v1/research-api/settings", { method: "OPTIONS" }));
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /PUT/);
});

test("settings: defaults, where each key comes from, and never the key itself", async () => {
  const res = await get("settings");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.ai, { defaultTier: "free", fanout: 3, topK: 8, freeModels: [], freeChecker: "", paidModel: "" });
  assert.equal(data.keys.openrouter.source, "supabase");
  assert.equal(data.keys.gemini.source, "supabase");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("or-key") && !text.includes("gem-key"), "key values must never be returned");
  assert.equal(data.models.current.free.generators.length, 3);
});

test("settings are only for allowlisted users", async () => {
  assert.equal((await get("settings", "")).status, 401);
  scenario.user = { email: "stranger@example.com" };
  assert.equal((await get("settings")).status, 403);
  assert.equal((await put("settings", { ai: { fanout: 1 } })).status, 403);
  assert.equal((await put("settings/keys", { name: "openrouter", value: VALID_OR_KEY })).status, 403);
  assert.deepEqual(db, { appSettings: {}, vault: {} });
});

test("settings reject out-of-range or malformed values", async () => {
  for (const ai of [{ fanout: 5 }, { topK: 7 }, { defaultTier: "gold" }, { freeModels: ["not a model"] }, { paidModel: "x" }]) {
    const res = await put("settings", { ai });
    assert.equal(res.status, 400, JSON.stringify(ai));
  }
  assert.deepEqual(db.appSettings, {});
});

test("saved AI settings drive the next answer: models, drafting count and passages", async () => {
  scenario.catalog = [
    { id: "acme/chosen-model:free", pricing: FREE, context_length: 131072 },
    { id: "acme/chosen-checker:free", pricing: FREE, context_length: 131072 },
    { id: "deepseek/deepseek-chat-v3.1:free", pricing: FREE, context_length: 163840 },
  ];
  const saved = await put("settings", {
    ai: { fanout: 2, topK: 6, freeModels: ["acme/chosen-model:free"], freeChecker: "acme/chosen-checker:free" },
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).ai.fanout, 2);
  assert.equal((db.appSettings.ai as { topK: number }).topK, 6);

  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[]; checker: string };
  assert.deepEqual(meta.generators, ["acme/chosen-model:free", "deepseek/deepseek-chat-v3.1:free"]);
  assert.equal(meta.checker, "acme/chosen-checker:free");
  const search = calls.find((c) => c.url.endsWith("/rpc/match_chunks"))!;
  assert.equal((search.body as { match_count: number }).match_count, 6);
  assert.equal(completions().length, 3, "two drafts + one check");
});

test("a chosen paid model drafts and checks paid answers", async () => {
  scenario.catalog = [{ id: "openai/gpt-5", pricing: PAID, context_length: 400000 }];
  assert.equal((await put("settings", { ai: { paidModel: "openai/gpt-5" } })).status, 200);
  const evs = await events(await chat({ messages: [{ role: "user", content: "q" }], tier: "paid" }));
  const meta = evs.find((e) => e.type === "meta") as { generators: string[]; checker: string };
  assert.deepEqual(meta.generators, ["openai/gpt-5"]);
  assert.equal(meta.checker, "openai/gpt-5");
});

test("a key that OpenRouter rejects is not saved", async () => {
  const res = await put("settings/keys", { name: "openrouter", value: "sk-or-v1-wrong-key-0000000" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /rejected this key/);
  assert.deepEqual(db.vault, {});
});

test("a key that Google rejects is not saved", async () => {
  const res = await put("settings/keys", { name: "gemini", value: BAD_GEMINI_KEY });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Google rejected this key/);
  assert.deepEqual(db.vault, {});
});

test("incomplete-looking keys are refused before contacting anyone", async () => {
  for (const value of ["short", "sk-or-v1 with spaces in it", ""]) {
    assert.equal((await put("settings/keys", { name: "openrouter", value })).status, 400);
  }
  assert.equal((await put("settings/keys", { name: "aws", value: VALID_OR_KEY })).status, 400);
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/key")).length, 0);
});

test("a key saved on the Settings page is used instead of the Supabase secret, and can be removed", async () => {
  assert.equal((await put("settings/keys", { name: "openrouter", value: VALID_OR_KEY })).status, 200);
  assert.equal(db.vault.rfb_openrouter_api_key, VALID_OR_KEY);

  const view = await (await get("settings")).json();
  assert.deepEqual(view.keys.openrouter, { source: "settings", hint: "\u2022\u2022\u2022\u20227890" });
  assert.ok(!JSON.stringify(view).includes(VALID_OR_KEY));

  calls = [];
  await events(await chat({ messages: [{ role: "user", content: "q" }] }));
  const sent = completions().map((c) => c.headers.Authorization);
  assert.ok(sent.length && sent.every((h) => h === `Bearer ${VALID_OR_KEY}`), "answers use the saved key");

  assert.equal((await put("settings/keys", { name: "openrouter", value: null })).status, 200);
  assert.deepEqual(db.vault, {});
  assert.equal((await (await get("settings")).json()).keys.openrouter.source, "supabase");
});

test("health counts a key saved on the Settings page even without the Supabase secret", async () => {
  delete ENV.OPENROUTER_API_KEY;
  let data = await (await handler(new Request("https://p/functions/v1/research-api/health"))).json();
  assert.equal(data.configured.openrouter, false);
  db.vault.rfb_openrouter_api_key = VALID_OR_KEY;
  data = await (await handler(new Request("https://p/functions/v1/research-api/health"))).json();
  assert.equal(data.configured.openrouter, true);
});

test("documents route includes the document loader's last run", async () => {
  db.appSettings.library = { folderId: "folder123", finishedAt: "2026-10-12T09:04:00Z", loaded: 2 };
  const data = await (await get("documents")).json();
  assert.deepEqual(data.library, { folderId: "folder123", finishedAt: "2026-10-12T09:04:00Z", loaded: 2 });
});

test("unknown routes are 404 without touching auth", async () => {
  const res = await get("nope");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test("documents route returns corpus status", async () => {
  const res = await handler(
    new Request("https://p/functions/v1/research-api/documents", { headers: { Authorization: "Bearer t" } }),
  );
  const data = await res.json();
  assert.equal(data.embeddedChunks, 999);
  assert.equal(data.documents[0].title, "Contract Case List 2024.md");
});

test("rejects malformed chat bodies", async () => {
  const res = await chat({ messages: [{ role: "assistant", content: "no question" }] });
  assert.equal(res.status, 400);
});
