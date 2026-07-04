import type { CitationVerification } from "@/lib/types";
import { CANLII_NOT_CONFIGURED, verifyCanadianCitation } from "./canlii";
import { getCached, normalizeCitation, setCached } from "./cache";
import { verifyUSCitations } from "./courtlistener";
import { extractCanadianCitations } from "./extract";

/**
 * Stage 4 of the pipeline: verify every case citation in the checked answer,
 * routed by jurisdiction (US → CourtListener, CA → CanLII). Best-effort — any
 * provider failure degrades to fewer results, never an error. Canadian lookups
 * are cached per citation (each is a separate API call).
 */
export async function verifyCitations(answer: string): Promise<CitationVerification[]> {
  const [us, ca] = await Promise.all([
    verifyUSCitations(answer).catch(() => []),
    verifyCanadaAll(answer).catch(() => []),
  ]);

  const seen = new Set<string>();
  const out: CitationVerification[] = [];
  for (const v of [...ca, ...us]) {
    const key = normalizeCitation(v.citation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

async function verifyCanadaAll(answer: string): Promise<CitationVerification[]> {
  const cites = extractCanadianCitations(answer);
  return Promise.all(
    cites.map(async (c) => {
      const cached = await getCached("canlii", c.raw);
      if (cached) return cached;

      const result = await verifyCanadianCitation(c);
      // Don't cache the "not configured" placeholder — it should re-check once a key is set.
      if (result.note !== CANLII_NOT_CONFIGURED) {
        await setCached("canlii", c.raw, result);
      }
      return result;
    }),
  );
}
