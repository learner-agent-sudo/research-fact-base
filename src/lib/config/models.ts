import type { Tier } from "@/lib/types";

/**
 * Model configuration. Everything is env-overridable so models can be swapped
 * without code changes (see PLAN.md §4). Slugs are OpenRouter model IDs — VERIFY
 * them against https://openrouter.ai/models, as availability changes over time.
 */

// Free-tier defaults use OpenRouter ":free" model variants so a free OpenRouter
// account works with no credits. Verify availability at openrouter.ai/models —
// free slugs change over time, so the checker is a fallback LIST (tried in
// order). NOTE: free models require enabling free-model usage in OpenRouter
// privacy settings (openrouter.ai/settings/privacy).
const DEFAULT_FREE_GENERATORS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "qwen/qwen-2.5-72b-instruct:free",
];
const DEFAULT_FREE_CHECKER = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat-v3-0324:free",
];

const DEFAULT_PAID_GENERATORS = ["anthropic/claude-3.7-sonnet"];
const DEFAULT_PAID_CHECKER = ["anthropic/claude-3.7-sonnet"];

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

export const MODELS = {
  free: {
    generators: envList("FREE_GENERATORS", DEFAULT_FREE_GENERATORS),
    checker: envList("FREE_CHECKER", DEFAULT_FREE_CHECKER),
  },
  paid: {
    generators: envList("PAID_GENERATORS", DEFAULT_PAID_GENERATORS),
    checker: envList("PAID_CHECKER", DEFAULT_PAID_CHECKER),
  },
} as const;

/** Number of generators to fan out to in the ensemble (accuracy > latency). */
export const FANOUT = Math.max(1, Number(process.env.FANOUT || 3));

/** checker is a fallback list, tried in order (see runChecker). */
export function modelsForTier(tier: Tier): { generators: string[]; checker: string[] } {
  const t = tier === "paid" ? MODELS.paid : MODELS.free;
  return { generators: [...t.generators], checker: [...t.checker] };
}
