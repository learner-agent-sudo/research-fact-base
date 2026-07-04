import { syncCorpus } from "@/lib/ingest/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60s keeps within Vercel's Hobby-plan limit. Large first-time ingests of big
// files are best run locally (npm run dev); Vercel handles incremental syncs.
export const maxDuration = 60;

/** Optional admin gate: if ADMIN_TOKEN is set, require it in x-admin-token. */
function authorized(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true; // open in local dev when unset
  return req.headers.get("x-admin-token") === token;
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const result = await syncCorpus();
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
