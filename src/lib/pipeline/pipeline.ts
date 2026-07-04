import { FANOUT, modelsForTier } from "@/lib/config/models";
import { OpenRouterMissingKeyError } from "@/lib/models/openrouter";
import { retrieve } from "@/lib/retrieval/retriever";
import { webSearch } from "@/lib/search/websearch";
import type { ChatMessage, Source, StreamEvent, Tier } from "@/lib/types";
import { verifyCitations } from "@/lib/verify";
import type { CheckerMeta } from "@/lib/types";
import { runChecker } from "./check";
import { runGenerators } from "./generate";
import { tagSources } from "./sources";

const NO_KEY_MESSAGE =
  "⚠️ No `OPENROUTER_API_KEY` is configured yet, so I can't generate a grounded answer.\n\n" +
  "Add your OpenRouter key to `.env.local` (see `.env.example`) and restart. " +
  "The full pipeline — Drive retrieval, web search, the model ensemble, and the checker — " +
  "is wired and ready to run once keys are set.";

/**
 * The five-stage answer pipeline (PLAN.md §2):
 *   1. gather sources (Drive RAG + web search)
 *   2. generate (free-tier ensemble or paid model)
 *   3. check & consolidate (streams the final answer)
 *   4. citation verification  — Phase 3, not yet wired
 *   5. compose                — assembled by the client from these events
 */
export async function* runPipeline(
  messages: ChatMessage[],
  tier: Tier,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const history = messages.slice(0, -1); // prior turns (context for follow-ups)

  // 1. Gather sources. Each provider is best-effort; missing keys just yield [].
  let sources: Source[] = [];
  try {
    const [drive, web] = await Promise.all([retrieve(question), webSearch(question)]);
    sources = tagSources([...drive, ...web]);
  } catch {
    sources = [];
  }
  yield { type: "sources", sources };

  const { generators, checker } = modelsForTier(tier);
  const activeGenerators = generators.slice(0, FANOUT);
  yield { type: "meta", tier, generators: activeGenerators, checker };

  try {
    // 2. Generate (ensemble, in parallel).
    const drafts = await runGenerators(activeGenerators, question, history, sources, signal);

    // 3. Check & consolidate (streamed); accumulate the answer for verification.
    let answer = "";
    let meta: CheckerMeta | null = null;
    for await (const ev of runChecker(checker, question, history, sources, drafts, signal)) {
      if (ev.kind === "delta") {
        answer += ev.text;
        yield { type: "delta", text: ev.text };
      } else {
        meta = ev.meta;
      }
    }

    // 4. Verify case citations (US → CourtListener, CA → CanLII). Best-effort.
    if (answer.trim()) {
      const items = await verifyCitations(answer).catch(() => []);
      if (items.length) yield { type: "verifications", items };
    }

    yield {
      type: "done",
      confidence: meta?.confidence ?? (sources.length ? "medium" : "low"),
      unsupported: meta?.unsupported ?? [],
    };
  } catch (err) {
    if (err instanceof OpenRouterMissingKeyError) {
      yield { type: "delta", text: NO_KEY_MESSAGE };
      yield { type: "done", confidence: "low", unsupported: [] };
    } else {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
