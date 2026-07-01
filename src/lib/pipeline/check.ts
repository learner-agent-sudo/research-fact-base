import { stream } from "@/lib/models/openrouter";
import { CHECKER_SYSTEM } from "./prompts";
import { formatSourcesBlock } from "./sources";
import type { ChatMessage, CheckerMeta, Confidence, GeneratorDraft, Source } from "@/lib/types";

const SENTINEL = "<<<META>>>";

export type CheckerEvent =
  | { kind: "delta"; text: string }
  | { kind: "meta"; meta: CheckerMeta };

/**
 * Stream the checker's consolidated answer. The checker appends a `<<<META>>>`
 * sentinel followed by a JSON meta block; we forward the answer text to the
 * client and withhold the meta, parsing it once the stream ends.
 */
export async function* runChecker(
  model: string,
  question: string,
  history: ChatMessage[],
  sources: Source[],
  drafts: GeneratorDraft[],
  signal?: AbortSignal,
): AsyncGenerator<CheckerEvent> {
  const draftsBlock =
    drafts
      .filter((d) => d.content)
      .map((d, i) => `--- Candidate ${i + 1} (${d.model}) ---\n${d.content}`)
      .join("\n\n") || "(no candidate answers were produced)";

  const userContent =
    `SOURCES:\n${formatSourcesBlock(sources)}\n\n` +
    `CANDIDATE ANSWERS:\n${draftsBlock}\n\n` +
    `QUESTION:\n${question}`;

  const messages = [
    { role: "system", content: CHECKER_SYSTEM },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];

  let buffer = "";
  let emitted = 0; // chars of `buffer` already sent to the client as answer text
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
    // Emit everything except a possible partial sentinel forming at the tail.
    const safeEnd = Math.max(emitted, buffer.length - SENTINEL.length);
    if (safeEnd > emitted) {
      yield { kind: "delta", text: buffer.slice(emitted, safeEnd) };
      emitted = safeEnd;
    }
  }

  // No sentinel seen — flush the remainder as answer text.
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
