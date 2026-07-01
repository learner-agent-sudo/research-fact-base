/**
 * Minimal OpenRouter client — the single gateway to every model (Grok, Gemini,
 * Llama, Claude, …). Uses the OpenAI-compatible chat-completions endpoint.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatOpts {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  signal?: AbortSignal;
}

export class OpenRouterMissingKeyError extends Error {
  constructor() {
    super("OPENROUTER_API_KEY is not set");
    this.name = "OpenRouterMissingKeyError";
  }
}

function headers(): Record<string, string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new OpenRouterMissingKeyError();
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    // OpenRouter attribution headers (optional but recommended):
    "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
    "X-Title": "Research Fact Base",
  };
}

/** Non-streaming completion. Used for the generator ensemble. */
export async function complete(opts: ChatOpts): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${opts.model} error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Streaming completion (SSE). Used for the checker so the final answer streams. */
export async function* stream(opts: ChatOpts): AsyncGenerator<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const body = res.ok ? "" : await res.text().catch(() => "");
    throw new Error(`OpenRouter ${opts.model} stream error ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue; // skip SSE comments / keep-alives
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        // partial JSON across chunk boundaries — ignore, it will complete later
      }
    }
  }
}
