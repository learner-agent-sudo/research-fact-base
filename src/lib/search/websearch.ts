import type { Source } from "@/lib/types";

/**
 * Live web-search source provider. Pluggable; the default implementation uses
 * Tavily (set TAVILY_API_KEY). Returns [] when no provider key is configured,
 * so web search is an optional grounding source, not a hard dependency.
 *
 * The deployed app cannot use the agent's WebSearch/WebFetch tools, so it needs
 * a real search API — Tavily here; swap for Brave/Serper/etc. behind this fn.
 */
export async function webSearch(query: string): Promise<Source[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: 5,
        search_depth: "advanced",
        include_answer: false,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results: unknown[] = Array.isArray(data?.results) ? data.results : [];
    return results.map((raw, i) => {
      const r = raw as { title?: string; url?: string; content?: string };
      return {
        id: `W${i + 1}`, // re-tagged sequentially by the pipeline
        type: "web" as const,
        title: r.title || r.url || "web result",
        url: r.url,
        snippet: (r.content || "").slice(0, 1200),
      };
    });
  } catch {
    return [];
  }
}
