import type { CitationVerification } from "@/lib/types";
import { COURT_DB } from "./courts";
import type { CanadianCitation } from "./extract";

export const CANLII_NOT_CONFIGURED = "CanLII not configured";

/**
 * Verify a Canadian neutral citation against the CanLII API (metadata/citator
 * only — there is no free-text case search). We resolve the citation to a
 * (databaseId, caseId) and fetch the case metadata; a 200 confirms the case
 * exists and yields its canonical name + decision date.
 */
export async function verifyCanadianCitation(cite: CanadianCitation): Promise<CitationVerification> {
  const key = process.env.CANLII_API_KEY;
  const base: Omit<CitationVerification, "status"> = {
    citation: cite.raw,
    jurisdiction: "CA",
    provider: "canlii",
  };
  if (!key) return { ...base, status: "unverified", note: CANLII_NOT_CONFIGURED };

  const databaseId = COURT_DB[cite.court] || cite.court.toLowerCase();
  const caseId = `${cite.year}${cite.court.toLowerCase()}${cite.number}`;
  const url =
    `https://api.canlii.org/v1/caseBrowse/en/${databaseId}/${caseId}/` +
    `?api_key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url);
    if (res.status === 200) {
      const data = (await res.json()) as { title?: string; decisionDate?: string };
      return {
        ...base,
        status: "verified",
        caseName: data.title,
        date: data.decisionDate,
        url: `https://www.canlii.org/en/#search/text=${encodeURIComponent(cite.raw)}`,
      };
    }
    return { ...base, status: "unverified", note: `not found on CanLII (${res.status})` };
  } catch {
    return { ...base, status: "unverified", note: "CanLII lookup error" };
  }
}
