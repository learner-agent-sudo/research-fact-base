import type { Tier } from "@/lib/types";

/**
 * Model configuration. Everything is env-overridable so models can be swapped
 * without code changes (see PLAN.md §4). Slugs are OpenRouter model IDs — VERIFY
 * them against https://openrouter.ai/models, as availability changes over time.
 */

const DEFAULT_FREE_GENERATORS = [
  "meta-llama/llama-3.3-70b-instruct",
  "google/gemini-2.0-flash-exp:free",
  "mistralai/mistral-small-3.1-24b-instruct",
];
const DEFAULT_FREE_CHECKER = "google/gemini-2.5-flash";

const DEFAULT_PAID_GENERATORS = ["anthropic/claude-3.7-sonnet"];
const DEFAULT_PAID_CHECKER = "anthropic/claude-3.7-sonnet";

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
    checker: process.env.FREE_CHECKER || DEFAULT_FREE_CHECKER,
  },
  paid: {
    generators: envList("PAID_GENERATORS", DEFAULT_PAID_GENERATORS),
    checker: process.env.PAID_CHECKER || DEFAULT_PAID_CHECKER,
  },
} as const;

/** Number of generators to fan out to in the ensemble (accuracy > latency). */
export const FANOUT = Math.max(1, Number(process.env.FANOUT || 3));

export function modelsForTier(tier: Tier): { generators: string[]; checker: string } {
  return tier === "paid" ? MODELS.paid : MODELS.free;
}
