/**
 * Test doubles for the browser tests.
 *
 * The website under test is the real static build, and the research API is
 * the real edge function code (supabase/functions/research-api), run in the
 * test process for each request the browser makes. Only the outside services
 * are simulated: Supabase Auth, the database, Gemini and OpenRouter. Any
 * request that would leave the machine is blocked and fails the test.
 */
import type { Page, Route } from "@playwright/test";

export const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? "https://zfzydmozafepouflrlxb.supabase.co";
export const ALLOWED = "owner@example.com";
export const STRANGER = "stranger@example.com";
export const CODE = "246810";

const CHECKER_OUTPUT =
  "There is a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1]. " +
  "It was extended in Callow v Zollinger, 2020 SCC 45 [S1].\n" +
  '<<<META>>>{"confidence":"high","unsupported":[],"quotes":[{"source":"S1","text":"a duty of honest performance in contractual dealings"}]}';

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

const DOCS = [
  { id: "d1", title: "Contract Case List 2024.md", mime_type: "text/markdown", status: "ready" },
  { id: "d2", title: "family-law.md", mime_type: "text/markdown", status: "ingesting" },
];

function freshEnv(): Record<string, string | undefined> {
  return {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "eyJservice-role-test-key",
    SUPABASE_ANON_KEY: "anon-test-key",
    OPENROUTER_API_KEY: "or-test-key",
    GEMINI_API_KEY: "gemini-test-key",
    ALLOWED_EMAILS: `${ALLOWED}, colleague@example.com`,
  };
}

/** Everything the fakes saw, plus knobs a test can turn. Reset before each test. */
export const world = {
  env: freshEnv(),
  rows: ROWS as unknown[],
  otpError: null as null | { status: number; error_code: string; msg: string },
  otpRequests: [] as { redirectTo: string | null; body: Record<string, unknown> }[],
  verifyRequests: [] as Record<string, unknown>[],
  apiRequests: [] as { route: string; headers: Record<string, string>; body: unknown }[],
  modelCalls: [] as string[],
  logouts: 0,
  leaked: [] as string[],
};

const accessTokens = new Map<string, string>(); // access token -> email
const refreshTokens = new Map<string, string>(); // refresh token -> email

export function resetWorld() {
  world.env = freshEnv();
  world.rows = ROWS;
  world.otpError = null;
  world.otpRequests = [];
  world.verifyRequests = [];
  world.apiRequests = [];
  world.modelCalls = [];
  world.logouts = 0;
  world.leaked = [];
  accessTokens.clear();
  refreshTokens.clear();
}

/** Makes every issued access token invalid, as if the session expired server-side. */
export function expireAllSessions() {
  accessTokens.clear();
}

// ---------------------------------------------------------------------------
// Fake Supabase Auth
// ---------------------------------------------------------------------------

function userFor(email: string) {
  return {
    id: `user-${email}`,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

let issued = 0;
function issueSession(email: string) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  issued += 1;
  const access_token = [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ sub: `user-${email}`, email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, n: issued }),
    "signature",
  ].join(".");
  const refresh_token = `refresh-${issued}`;
  accessTokens.set(access_token, email);
  refreshTokens.set(refresh_token, email);
  return { access_token, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token, user: userFor(email) };
}

/** The URL a Supabase sign-in email link redirects to after a successful click. */
export function magicLinkLanding(email: string): string {
  const s = issueSession(email);
  const hash = new URLSearchParams({
    access_token: s.access_token,
    expires_at: String(s.expires_at),
    expires_in: String(s.expires_in),
    refresh_token: s.refresh_token,
    token_type: "bearer",
    type: "magiclink",
  });
  return `./#${hash}`;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function fulfillJson(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(data) });
}

function bearer(headers: Record<string, string>): string {
  return (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

async function fakeAuth(route: Route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const url = new URL(req.url());
  const path = url.pathname.replace("/auth/v1", "");
  const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;

  if (path === "/otp") {
    world.otpRequests.push({ redirectTo: url.searchParams.get("redirect_to"), body });
    if (world.otpError) {
      const { status, error_code, msg } = world.otpError;
      return fulfillJson(route, { code: status, error_code, msg }, status);
    }
    return fulfillJson(route, {});
  }
  if (path === "/verify") {
    world.verifyRequests.push(body);
    if (body.token === CODE) return fulfillJson(route, issueSession(String(body.email)));
    return fulfillJson(route, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403);
  }
  if (path === "/user") {
    const email = accessTokens.get(bearer(await req.allHeaders()));
    return email
      ? fulfillJson(route, userFor(email))
      : fulfillJson(route, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, 403);
  }
  if (path === "/token" && url.searchParams.get("grant_type") === "refresh_token") {
    const email = refreshTokens.get(String(body.refresh_token));
    return email
      ? fulfillJson(route, issueSession(email))
      : fulfillJson(route, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }, 400);
  }
  if (path === "/logout") {
    world.logouts += 1;
    return route.fulfill({ status: 204, headers: CORS });
  }
  return fulfillJson(route, { msg: `fake auth: no route for ${path}` }, 404);
}

// ---------------------------------------------------------------------------
// Real edge function, with its outbound calls answered by fakes
// ---------------------------------------------------------------------------

(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (k: string) => world.env[k] } };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const reply = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });

  if (url === `${SUPABASE_URL}/auth/v1/user`) {
    const email = accessTokens.get(bearer(headers));
    return email ? reply(userFor(email)) : reply({ msg: "invalid JWT" }, 403);
  }
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/admin/`)) return reply({ msg: "not admin" }, 401);
  if (url.includes(":embedContent")) {
    return reply({ embedding: { values: Array.from({ length: 1024 }, (_, i) => (i % 7) / 7) } });
  }
  if (url === `${SUPABASE_URL}/rest/v1/rpc/match_chunks`) return reply(world.rows);
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/documents`)) return reply(DOCS);
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/chunks`)) return reply([{ id: "c1" }], 200, { "content-range": "0-0/1234" });
  if (url === "https://openrouter.ai/api/v1/chat/completions") {
    const { model, messages } = body as { model: string; messages: { content: string }[] };
    world.modelCalls.push(model);
    const isChecker = messages[0].content.startsWith("You are a strict verifier");
    return reply({ choices: [{ message: { content: isChecker ? CHECKER_OUTPUT : "draft answer [S1]" } }] });
  }
  world.leaked.push(`edge function -> ${url}`);
  return reply({ error: "blocked by test" }, 599);
}) as typeof fetch;

type Handler = (req: Request) => Promise<Response>;
let handler: Handler | null = null;
function edgeFunction(): Handler {
  // Loaded lazily so the Deno/fetch stand-ins above are in place first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  handler ??= (require("../supabase/functions/research-api/index.ts") as { handler: Handler }).handler;
  return handler;
}

async function realApi(route: Route) {
  const req = route.request();
  const headers = await req.allHeaders();
  const method = req.method();
  const raw = req.postDataBuffer();
  const apiRoute = new URL(req.url()).pathname.split("/").pop() ?? "";
  if (method !== "OPTIONS") {
    world.apiRequests.push({ route: apiRoute, headers, body: raw ? JSON.parse(raw.toString()) : undefined });
  }
  const forwarded = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(":") && k !== "host"));
  const res = await edgeFunction()(
    new Request(req.url(), {
      method,
      headers: forwarded,
      body: method === "GET" || method === "OPTIONS" || !raw ? undefined : new Uint8Array(raw),
    }),
  );
  await route.fulfill({
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: Buffer.from(await res.arrayBuffer()),
  });
}

/** Routes the page's network: the site itself is served locally; nothing else leaves the machine. */
export async function installFakes(page: Page, siteOrigin: string) {
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(siteOrigin) || url.startsWith("data:")) return route.continue();
    world.leaked.push(`browser -> ${url}`);
    return route.abort("blockedbyclient");
  });
  await page.route(`${SUPABASE_URL}/auth/v1/**`, fakeAuth);
  await page.route(`${SUPABASE_URL}/functions/v1/research-api/**`, realApi);
}
