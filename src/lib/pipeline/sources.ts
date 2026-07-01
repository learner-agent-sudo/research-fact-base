import type { Source } from "@/lib/types";

/** Render the source registry into the block shown to the models. */
export function formatSourcesBlock(sources: Source[]): string {
  if (sources.length === 0) {
    return "(No sources were found for this question. Do not answer from outside knowledge.)";
  }
  return sources
    .map((s) => `[${s.id}] ${s.title}${s.url ? ` — ${s.url}` : ""}\n${s.snippet}`)
    .join("\n\n");
}

/** Assign stable, sequential tags (S1, S2, …) to a gathered source list. */
export function tagSources(sources: Source[]): Source[] {
  return sources.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}
