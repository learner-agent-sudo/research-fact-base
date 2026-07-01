import { complete } from "@/lib/models/openrouter";
import { GENERATOR_SYSTEM } from "./prompts";
import { formatSourcesBlock } from "./sources";
import type { ChatMessage, GeneratorDraft, Source } from "@/lib/types";

/**
 * Fan out the same question + sources to the generator ensemble, in parallel.
 * A failing model does not abort the others (Promise.allSettled).
 */
export async function runGenerators(
  models: string[],
  question: string,
  history: ChatMessage[],
  sources: Source[],
  signal?: AbortSignal,
): Promise<GeneratorDraft[]> {
  const userContent = `SOURCES:\n${formatSourcesBlock(sources)}\n\nQUESTION:\n${question}`;
  const messages = [
    { role: "system", content: GENERATOR_SYSTEM },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];

  const settled = await Promise.allSettled(
    models.map((model) => complete({ model, messages, signal, temperature: 0.2 })),
  );

  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { model: models[i], content: r.value }
      : { model: models[i], content: "", error: String(r.reason) },
  );
}
