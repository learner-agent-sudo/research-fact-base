import type { NextRequest } from "next/server";
import { runPipeline } from "@/lib/pipeline/pipeline";
import type { ChatMessage, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const b = body as { messages?: ChatMessage[]; tier?: string };
  const messages: ChatMessage[] = Array.isArray(b?.messages) ? b.messages : [];
  const tier: Tier = b?.tier === "paid" ? "paid" : "free";

  if (messages.length === 0) {
    return new Response("No messages provided", { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        for await (const ev of runPipeline(messages, tier, req.signal)) {
          write(ev);
        }
      } catch (err) {
        write({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
