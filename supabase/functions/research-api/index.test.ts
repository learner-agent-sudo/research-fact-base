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
}
let scenario: Scenario = {};
let calls: { url: string; body?: unknown }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, body });
  const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

  if (url.endsWith("/auth/v1/user")) {
    return scenario.user ? reply(scenario.user) : reply({ msg: "bad jwt" }, 401);
  }
  if (url.includes(":embedContent")) {
    return reply({ embedding: { values: Array.from({ length: 1024 }, (_, i) => (i % 7) / 7) } });
  }
  if (url.endsWith("/rpc/match_chunks")) return reply(scenario.rows ?? ROWS);
  if (url.includes("/rest/v1/documents")) {
    return reply([{ id: "d1", title: "Contract Case List 2024.md", mime_type: "text/markdown", status: "ready" }]);
  }
  if (url.includes("/rest/v1/chunks")) return reply([{ id: "c1" }], 200, { "content-range": "0-0/999" });
  if (url.includes("openrouter.ai")) {
    const system = (body as { messages: { content: string }[] }).messages[0].content;
    const isChecker = system.startsWith("You are a strict verifier");
    if (isChecker) {
      const priorCheckerCalls = calls.filter(
        (c) => c.url.includes("openrouter.ai") &&
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

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type !== "ping");
}

const chat = (body: unknown, token = "user-jwt") =>
  handler(
    new Request("https://proj.supabase.co/functions/v1/research-api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
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
  assert.equal(calls.filter((c) => c.url.includes("openrouter.ai")).length, 4);
  // Service role key used for the vector search, sent to Supabase only.
  const search = calls.find((c) => c.url.endsWith("/rpc/match_chunks"))!;
  assert.equal((search.body as { match_count: number }).match_count, 8);
});

test("abstains without calling any model when nothing relevant is retrieved", async () => {
  scenario.rows = [];
  const evs = await events(await chat({ messages: [{ role: "user", content: "Unrelated?" }] }));
  const final = evs.find((e) => e.type === "final") as { text: string };
  assert.match(final.text, /don't contain anything relevant/);
  assert.equal(calls.filter((c) => c.url.includes("openrouter.ai")).length, 0);
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
