#!/usr/bin/env node
/**
 * Live smoke test of the deployed app: the GitHub Pages site, Supabase Auth,
 * and the research-api edge function. Sends no email and changes no data.
 * Run by GitHub Actions (.github/workflows/smoke-test.yml).
 *
 *   SITE_URL                   https://<owner>.github.io/<repo>/
 *   SUPABASE_URL               https://<ref>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY   the public key the site uses
 *   SUPABASE_SERVICE_ROLE_KEY  optional: unlocks the corpus check and real questions
 *   ASK=1                      ask real questions end to end (~8 free OpenRouter requests)
 */
import { appendFileSync } from "node:fs";

const SITE = must("SITE_URL").replace(/\/?$/, "/");
const SUPABASE = must("SUPABASE_URL").replace(/\/$/, "");
const PUBLIC_KEY = must("SUPABASE_PUBLISHABLE_KEY");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
const ASK = process.env.ASK === "1" || process.env.ASK === "true";
const FN = `${SUPABASE}/functions/v1/research-api`;

const ABSTAIN = "Your documents don't contain anything relevant";
const QUESTIONS = [
  { q: "When must a lawyer withdraw from representing a client?", expectAnswer: true },
  { q: "What is the boiling point of tungsten?", expectAnswer: false },
];

function must(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return v;
}

const results = [];
const notes = [];
function record(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`${ok === true ? "PASS" : ok === "warn" ? "WARN" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(true, name, typeof detail === "string" ? detail : "");
  } catch (e) {
    record(false, name, e instanceof Error ? e.message : String(e));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function get(url, init = {}) {
  const res = await fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(30_000) });
  return { res, text: await res.text() };
}

const fnHeaders = (token) => ({
  apikey: PUBLIC_KEY,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// --- 1. The website ---------------------------------------------------------

await check("Site: home page loads", async () => {
  const { res, text } = await get(SITE);
  assert(res.status === 200, `HTTP ${res.status} from ${SITE}`);
  assert(/<title>[^<]*Research Fact Base/.test(text), "page title is not the app's");
  const assets = [...new Set([...text.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
  assert(assets.length > 0, "no script/style files referenced");
  const broken = [];
  for (const a of assets) {
    const r = await fetch(new URL(a, SITE), { signal: AbortSignal.timeout(30_000) });
    await r.arrayBuffer();
    if (r.status !== 200) broken.push(`${r.status} ${a}`);
  }
  assert(!broken.length, `broken files: ${broken.join(", ")}`);
  return `${assets.length} script/style files all load`;
});

await check("Site: corpus page loads", async () => {
  const { res } = await get(`${SITE}admin/`);
  assert(res.status === 200, `HTTP ${res.status}`);
});

// --- 2. Supabase Auth ---------------------------------------------------------

await check("Auth: email sign-in is enabled", async () => {
  const { res, text } = await get(`${SUPABASE}/auth/v1/settings`, { headers: { apikey: PUBLIC_KEY } });
  assert(res.status === 200, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  const s = JSON.parse(text);
  assert(s.external?.email === true, "the Email provider is turned off (Authentication → Sign In / Providers)");
  return s.disable_signup ? "new sign-ups are off (good, once you've signed in)" : "new sign-ups are on";
});

// --- 3. The research API (edge function) ------------------------------------

await check("API: function is deployed and reachable", async () => {
  const { res, text } = await get(`${FN}/health`);
  assert(res.status === 200, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  assert(JSON.parse(text).ok === true, "unexpected health response");
});

await check("API: all server secrets are set", async () => {
  const { text } = await get(`${FN}/health`);
  const configured = JSON.parse(text).configured ?? {};
  const names = { openrouter: "OPENROUTER_API_KEY", gemini: "GEMINI_API_KEY", allowedEmails: "ALLOWED_EMAILS" };
  const missing = Object.entries(names).filter(([k]) => !configured[k]).map(([, v]) => v);
  assert(configured.supabase, "Supabase keys are not injected into the function");
  assert(!missing.length, `missing in Supabase → Edge Functions → Secrets: ${missing.join(", ")}`);
  return "OPENROUTER_API_KEY, GEMINI_API_KEY, ALLOWED_EMAILS";
});

await check("API: browser preflight (CORS) from the site is allowed", async () => {
  const origin = new URL(SITE).origin;
  const res = await fetch(`${FN}/chat`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,apikey,content-type,x-client-info",
    },
    signal: AbortSignal.timeout(30_000),
  });
  await res.arrayBuffer();
  assert(res.status >= 200 && res.status < 300, `HTTP ${res.status}`);
  const allow = res.headers.get("access-control-allow-origin");
  assert(allow === "*" || allow === origin, `Access-Control-Allow-Origin is ${allow}`);
});

await check("API: refuses requests without a signed-in user", async () => {
  const noToken = await get(`${FN}/me`, { headers: fnHeaders() });
  assert(noToken.res.status === 401, `no token → HTTP ${noToken.res.status}, expected 401`);
  const fake = await get(`${FN}/chat`, {
    method: "POST",
    headers: { ...fnHeaders("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged"), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  });
  assert(fake.res.status === 401, `forged token → HTTP ${fake.res.status}, expected 401`);
});

if (!SERVICE_KEY) {
  record("warn", "Corpus and question tests skipped", "SUPABASE_SERVICE_ROLE_KEY not provided");
} else {
  await check("API: corpus has searchable documents", async () => {
    const { res, text } = await get(`${FN}/documents`, { headers: fnHeaders(SERVICE_KEY) });
    assert(res.status === 200, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const { documents = [], embeddedChunks = 0 } = JSON.parse(text);
    const by = documents.reduce((a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a), {});
    assert(by.ready > 0 && embeddedChunks > 0, "no documents are ready to search yet");
    return `${by.ready ?? 0} ready, ${by.ingesting ?? 0} still loading, ${by.error ?? 0} skipped; ${embeddedChunks} passages`;
  });

  if (ASK) {
    for (const { q, expectAnswer } of QUESTIONS) {
      await check(`Answer: "${q}"`, () => askQuestion(q, expectAnswer));
    }
  }
}

async function askQuestion(question, expectAnswer) {
  const started = Date.now();
  const res = await fetch(`${FN}/chat`, {
    method: "POST",
    headers: { ...fnHeaders(SERVICE_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: question }], tier: "free" }),
    signal: AbortSignal.timeout(170_000),
  });
  const body = await res.text();
  assert(res.status === 200, `HTTP ${res.status}: ${body.slice(0, 300)}`);
  const events = body.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== "ping");
  const seconds = Math.round((Date.now() - started) / 1000);
  const error = events.find((e) => e.type === "error");
  assert(!error, `the app reported an error after ${seconds}s: ${error?.message}`);

  const sources = events.find((e) => e.type === "sources")?.sources ?? [];
  const meta = events.find((e) => e.type === "meta");
  const final = events.find((e) => e.type === "final");
  const done = events.find((e) => e.type === "done");
  assert(final && done, `stream ended without an answer after ${seconds}s`);

  // The guarantees the grounding code makes, checked on the live output:
  const ids = new Set(sources.map((s) => s.id));
  const badTags = [...final.text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]).filter((t) => !ids.has(t));
  assert(!badTags.length, `answer cites passages that weren't retrieved: ${badTags.join(", ")}`);
  const leaked = final.citations.filter((c) => !c.grounded && final.text.includes(c.text));
  assert(!leaked.length, `unverified citations left in the answer: ${leaked.map((c) => c.text).join(", ")}`);
  if (expectAnswer) {
    assert(sources.length > 0, "no passages were retrieved");
    assert(final.text.trim() && !final.text.startsWith(ABSTAIN), "the app found nothing to say");
  }

  const titles = [...new Set(sources.map((s) => s.title))];
  notes.push(
    `### ${question}`,
    "",
    final.text,
    "",
    `- ${seconds}s · confidence **${done.confidence}** · ${sources.length} passages from: ${titles.join("; ") || "none"}`,
    `- drafted by ${meta?.generators?.join(", ") || "—"} · checked by ${final.checker || "—"}`,
    `- quotes: ${final.quotes.map((x) => x.status).join(", ") || "none"} · removed by checks: ${final.removed.length}`,
    ...(done.unsupported?.length ? [`- notes: ${done.unsupported.join(" ")}`] : []),
    "",
  );
  return `${seconds}s, confidence ${done.confidence}, ${final.removed.length} sentence(s) removed`;
}

// --- Report -----------------------------------------------------------------

const failed = results.filter((r) => r.ok === false);
const icon = (ok) => (ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌");
const summary = [
  `## Live smoke test — ${failed.length ? `${failed.length} problem(s)` : "all good"}`,
  "",
  "| | Check | Detail |",
  "|---|---|---|",
  ...results.map((r) => `| ${icon(r.ok)} | ${r.name} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
  "",
  ...(notes.length ? ["## Answers from the live app", "", ...notes] : []),
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
console.log("\n" + summary);
process.exit(failed.length ? 1 : 0);
