import { CA_COURT_CODES } from "./courts";

export interface CanadianCitation {
  raw: string;
  year: string;
  court: string;
  number: string;
}

/**
 * Extract Canadian neutral citations (e.g. "2019 SCC 65") from answer text.
 * We only accept citations whose court code is a known Canadian tribunal, to
 * avoid false positives. US citations are handled by CourtListener (which does
 * its own extraction), so they are not matched here.
 */
export function extractCanadianCitations(text: string): CanadianCitation[] {
  const re = /\b((?:19|20)\d{2})\s+([A-Z]{2,6})\s+(\d+)\b/g;
  const out: CanadianCitation[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [raw, year, court, number] = m;
    if (!CA_COURT_CODES.has(court)) continue;
    const key = raw.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, year, court, number });
  }
  return out;
}
