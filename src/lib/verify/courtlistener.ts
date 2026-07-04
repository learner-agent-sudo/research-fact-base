import type { CitationVerification } from "@/lib/types";

/**
 * US citation verification via CourtListener's free citation-lookup API. It
 * extracts and resolves citations from raw text in one call, returning matched
 * case clusters (name, date, URL). Requires COURTLISTENER_API_TOKEN.
 * Docs: https://www.courtlistener.com/help/api/rest/citation-lookup/
 */
export async function verifyUSCitations(text: string): Promise<CitationVerification[]> {
  const token = process.env.COURTLISTENER_API_TOKEN;
  if (!token || !text.trim()) return [];

  const base = process.env.COURTLISTENER_API_BASE || "https://www.courtlistener.com/api/rest/v4";
  const res = await fetch(`${base}/citation-lookup/`, {
    method: "POST",
    headers: { Authorization: `Token ${token}` },
    body: new URLSearchParams({ text: text.slice(0, 64000) }),
  });
  if (!res.ok) return [];

  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map((c: Record<string, unknown>) => {
    const clusters = Array.isArray(c.clusters) ? (c.clusters as Record<string, unknown>[]) : [];
    const found = clusters.length > 0;
    const cluster = found ? clusters[0] : null;
    const absolute = cluster?.absolute_url as string | undefined;
    const status = c.status === 200 && found ? "verified" : "unverified";

    return {
      citation:
        (c.citation as string) ||
        (Array.isArray(c.normalized_citations) ? (c.normalized_citations[0] as string) : "citation"),
      jurisdiction: "US" as const,
      provider: "courtlistener" as const,
      status,
      caseName: cluster?.case_name as string | undefined,
      date: cluster?.date_filed as string | undefined,
      url: absolute ? `https://www.courtlistener.com${absolute}` : undefined,
      note: found ? undefined : ((c.error_message as string) || "not found in CourtListener"),
    };
  });
}
