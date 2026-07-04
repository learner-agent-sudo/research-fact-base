import { stream } from "@/lib/models/openrouter";
import { CHECKER_SYSTEM } from "./prompts";
import { formatSourcesBlock } from "./sources";
import type { ChatMessage, CheckerMeta, Confidence, GeneratorDraft, Source } from "@/lib/types";

const SENTINEL = "<<<META>>>";

export type CheckerEvent =
  | { kind: "delta"; text: string }
  | { kind: "meta"; meta: CheckerMeta };

/**
 * Stream the checker's consolidated answer, trying each candidate model in
 * order. Free models come and go on OpenRouter, so if one is unavailable (e.g.
 * a 404 before any output), we fall back to the next — a dead slug degrades
 * gracefully instead of breaking the whole answer.
 */
export async function* runChecker(
  models: string[],
  question: string,
  history: ChatMessage[],
  sources: Source[],
  drafts: GeneratorDraft[],
  signal?: AbortSignal,
): AsyncGenerator<CheckerEvent> {
  const messages = buildMessages(question, history, sources, drafts);
  const candidates = models.length ? models : ["meta-llama/llama-3.3-70b-instruct:free"];

  let lastErr: unknown;
  for (const model of candidates) {
    let produced = false;
    try {
      for await (const ev of streamOne(model, messages, sources, signal)) {
        if (ev.kind === "delta") produced = true;
        yield ev;
      }
      return; // this model completed the answer
    } catch (err) {
      lastErr = err;
      if (produced) {
        // Partial answer already streamed — don't restart on another model.
        yield { kind: "meta", meta: { confidence: "low", unsupported: ["checker interrupted mid-answer"] } };
        return;
      }
      // Model unavailable before producing anything — try the next candidate.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all checker models failed");
}

function buildMessages(
  question: string,
  history: ChatMessage[],
  sources: Source[],
  drafts: GeneratorDraft[],
): { role: string; content: string }[] {
  const draftsBlock =
    drafts
      .filter((d) => d.content)
      .map((d, i) => `--- Candidate ${i + 1} (${d.model}) ---\n${d.content}`)
      .join("\n\n") || "(no candidate answers were produced)";

  const userContent =
    `SOURCES:\n${formatSourcesBlock(sources)}\n\n` +
    `CANDIDATE ANSWERS:\n${draftsBlock}\n\n` +
    `QUESTION:\n${question}`;

  return [
    { role: "system", content: CHECKER_SYSTEM },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];
}

/**
 * Stream one checker model, splitting the answer text from the trailing
 * `<<<META>>>{...}` block (which we withhold and parse at the end).
 */
async function* streamOne(
  model: string,
  messages: { role: string; content: string }[],
  sources: Source[],
  signal?: AbortSignal,
): AsyncGenerator<CheckerEvent> {
  let buffer = "";
  let emitted = 0;
  let metaMode = false;
  let metaBuf = "";

  for await (const delta of stream({ model, messages, signal, temperature: 0.1 })) {
    if (metaMode) {
      metaBuf += delta;
      continue;
    }
    buffer += delta;
    const idx = buffer.indexOf(SENTINEL);
    if (idx !== -1) {
      const answerPart = buffer.slice(emitted, idx);
      if (answerPart) yield { kind: "delta", text: answerPart };
      metaMode = true;
      metaBuf = buffer.slice(idx + SENTINEL.length);
      emitted = buffer.length;
      continue;
    }
    const safeEnd = Math.max(emitted, buffer.length - SENTINEL.length);
    if (safeEnd > emitted) {
      yield { kind: "delta", text: buffer.slice(emitted, safeEnd) };
      emitted = safeEnd;
    }
  }

  if (!metaMode && buffer.length > emitted) {
    yield { kind: "delta", text: buffer.slice(emitted) };
  }
  yield { kind: "meta", meta: parseMeta(metaBuf, sources) };
}

function parseMeta(raw: string, sources: Source[]): CheckerMeta {
  const fallback: Confidence = sources.length === 0 ? "low" : "medium";
  const meta: CheckerMeta = { confidence: fallback, unsupported: [] };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low") {
        meta.confidence = parsed.confidence;
      }
      if (Array.isArray(parsed.unsupported)) {
        meta.unsupported = parsed.unsupported.map((x: unknown) => String(x)).filter(Boolean);
      }
    } catch {
      // keep fallback
    }
  }
  return meta;
}
