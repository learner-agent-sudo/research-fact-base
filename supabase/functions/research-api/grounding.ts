/**
 * Deterministic grounding checks - enforced in code, not by prompting.
 *
 * After the checker model drafts an answer, these checks keep it inside the
 * retrieved documents:
 *   1. Citation whitelist - every case citation, case name ("X v Y") and statute
 *      citation in the answer must appear in the retrieved source text.
 *   2. Quote verification - text in quotation marks must appear word-for-word
 *      in a source; supporting quotes the checker lists must appear in the
 *      specific source they are attributed to.
 *   3. Source-tag check - [S#] tags must refer to sources that were retrieved.
 *
 * Sentences that fail are removed before the user sees the answer, and every
 * removal is reported with its reason. Pure functions, no runtime APIs, so the
 * same file runs under Deno (Supabase Edge Functions) and Node (tests).
 */

export interface GroundingSource {
  id: string;
  title: string;
  snippet: string;
}

export type CitationKind = "neutral" | "reporter" | "statute" | "case";

export interface CitationCheck {
  text: string;
  kind: CitationKind;
  grounded: boolean;
}

export type QuoteStatus = "verified" | "misattributed" | "not_found";

export interface QuoteCheck {
  source: string;
  text: string;
  status: QuoteStatus;
  foundIn?: string;
}

export interface Removal {
  sentence: string;
  reason: string;
}

export interface GroundingReport {
  text: string;
  removed: Removal[];
  citations: CitationCheck[];
  quotes: QuoteCheck[];
}

export const NOTHING_LEFT =
  "I couldn't produce an answer that is fully supported by your documents. " +
  "The claims that failed the automatic source checks are listed below.";

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032`\u00B4]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;

function baseNorm(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\u00A0/g, " ");
}

/** Citation form: dots/apostrophes dropped (R.S.O. -> rso), other punctuation -> space, "vs" -> "v". */
export function normCite(s: string): string {
  return baseNorm(s)
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bvs\b/g, "v")
    .trim();
}

/** Word form for quotes: word-for-word, ignoring case, punctuation and spacing. */
export function normWords(s: string): string {
  return baseNorm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

const pad = (s: string) => ` ${s} `;

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

/** Uppercase tokens that look like neutral-citation court codes but aren't. */
const NOT_COURTS = new Set([
  "USD", "CAD", "EUR", "GBP", "AUD", "COVID", "AM", "PM", "UTC", "GMT",
  "EST", "EDT", "PST", "PDT", "CST", "CDT", "MST", "MDT", "FY", "Q",
]);

const CITATION_PATTERNS: { kind: CitationKind; re: RegExp; courtGroup?: number }[] = [
  // Neutral citations: 2014 SCC 71 | 2020 ONCA 123
  { kind: "neutral", re: /\b(?:19|20)\d{2}\s+([A-Z]{2,8})\s+\d{1,6}\b/g, courtGroup: 1 },
  // Bracketed-year reporters: [2014] 3 SCR 494 | [1995] 2 S.C.R. 1130 | [1932] AC 562
  { kind: "reporter", re: /\[(?:18|19|20)\d{2}\]\s+(?:\d{1,3}\s+)?(?:[A-Z][A-Za-z]{0,4}\.?\s?){1,4}\d{1,5}\b/g },
  // Series reporters: 40 OR (3d) 1 | 112 D.L.R. (4th) 1
  { kind: "reporter", re: /\b\d{1,4}\s+(?:[A-Z][A-Za-z]{0,4}\.?\s?){1,4}\((?:2d|3d|4th|5th|6th)\)\s+\d{1,5}\b/g },
  // US reporters: 410 U.S. 113 | 123 S. Ct. 456 | 5 F.3d 789 | 12 F. Supp. 2d 34
  {
    kind: "reporter",
    re: /\b\d{1,4}\s+(?:U\.?\s?S\.?|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.\s?Supp\.(?:\s?(?:2d|3d))?|F\.(?:\s?(?:2d|3d|4th))?)\s+\d{1,5}\b/g,
  },
  // Statutes: RSO 1990, c L.7 | R.S.C. 1985, c. C-46 | SO 2010, c 15
  { kind: "statute", re: /\b(?:R\.?\s?S\.?\s?)?[A-Z]{1,3}\.?\s(?:18|19|20)\d{2},?\s+c\.?\s?[A-Z]?[-.\d]*\d[A-Za-z\d.\-]*/g },
];

/** "Bhasin v Hrynew" | "R. v. Jordan" | "Canada (Attorney General) v Bedford". */
const CASE_NAME = /([A-Z][A-Za-z'\u2019&.\-]*)\)?,?\s+v\.?\s+([A-Z][A-Za-z'\u2019&\-]*)/g;

interface FoundCitation {
  text: string; // as written in the answer
  kind: CitationKind;
  key: string; // normalised form looked up in the sources
}

export function extractCitations(answer: string): FoundCitation[] {
  const out: FoundCitation[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: CitationKind, key: string) => {
    const k = `${kind}:${key}`;
    if (!key || seen.has(k)) return;
    seen.add(k);
    out.push({ text: text.trim(), kind, key });
  };

  for (const { kind, re, courtGroup } of CITATION_PATTERNS) {
    for (const m of answer.matchAll(re)) {
      if (courtGroup && NOT_COURTS.has(m[courtGroup])) continue;
      add(m[0], kind, normCite(m[0]));
    }
  }
  for (const m of answer.matchAll(CASE_NAME)) {
    // Match on the parties nearest the "v": robust to "R. v. Jordan" vs "R v Jordan"
    // and to long names like "Canada (Attorney General) v Bedford".
    add(m[0], "case", normCite(`${m[1]} v ${m[2]}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Text in double quotes, 20+ chars - long enough to be a claimed source quote. */
const INLINE_QUOTE = /["\u201C]([^"\u201C\u201D\n]{20,800})["\u201D]/g;

/** Split a quote on ellipses and [bracketed edits]; keep fragments of 3+ words. */
function quoteFragments(quote: string): string[] {
  return quote
    .split(/\.{3}|\u2026|\[[^\]]*\]/)
    .map(normWords)
    .filter((f) => f.split(" ").filter(Boolean).length >= 3);
}

/** True when every substantial fragment of `quote` appears word-for-word in `haystack`. */
function containsQuote(haystackWords: string, quote: string): boolean {
  const frags = quoteFragments(quote);
  return frags.length > 0 && frags.every((f) => haystackWords.includes(pad(f)));
}

export function checkSupportingQuotes(
  quotes: { source?: unknown; text?: unknown }[],
  sources: GroundingSource[],
): QuoteCheck[] {
  const words = new Map(sources.map((s) => [s.id.toUpperCase(), pad(normWords(s.snippet))]));
  const out: QuoteCheck[] = [];
  for (const q of quotes.slice(0, 12)) {
    const text = String(q?.text ?? "").trim();
    const source = String(q?.source ?? "").trim().toUpperCase();
    if (quoteFragments(text).length === 0) continue; // too short to be evidence
    const own = words.get(source);
    if (own && containsQuote(own, text)) {
      out.push({ source, text, status: "verified" });
      continue;
    }
    const elsewhere = sources.find((s) => containsQuote(words.get(s.id.toUpperCase())!, text));
    out.push(
      elsewhere
        ? { source, text, status: "misattributed", foundIn: elsewhere.id }
        : { source, text, status: "not_found" },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sentence splitting (legal-abbreviation aware)
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  "v", "vs", "no", "nos", "para", "paras", "p", "pp", "s", "ss", "art", "arts",
  "c", "ch", "cl", "sch", "reg", "regs", "e.g", "i.e", "etc", "inc", "ltd", "co",
  "corp", "dr", "mr", "mrs", "ms", "st", "j", "jj", "cj", "ca", "al", "fig",
  "vol", "ed", "eds", "ont", "que", "alta", "sask", "man", "nfld", "supp", "ct",
  "cf", "ibid", "id", "approx", "dept", "gov", "govt", "jr", "sr",
]);

/**
 * Split prose into sentences. Not a boundary: after an abbreviation ("v.",
 * "para."), an initial ("R."), a dotted abbreviation ("S.C.R."), inside an open
 * double quote, or when the next word starts lowercase.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const boundary = /[.!?]+["'\u201D\u2019)\]]*\s+/g;
  let start = 0;
  for (const m of text.matchAll(boundary)) {
    const punctAt = m.index!;
    const end = punctAt + m[0].length;
    const next = text[end] ?? "";
    if (!/[A-Z0-9"'\u201C\u2018(\[*_]/.test(next)) continue;

    const head = text.slice(0, punctAt);
    const word = (head.match(/([A-Za-z][A-Za-z.]*)$/) || [])[1] ?? "";
    if (text[punctAt] === "." && word) {
      const w = word.toLowerCase();
      if (ABBREVIATIONS.has(w) || /^[a-z]$/.test(w) || w.includes(".")) continue;
    }
    // Count quote marks through the end of the match, so a closing quote that
    // follows the full stop ('Now."') counts as closed.
    const upto = text.slice(0, end);
    const straight = (upto.match(/"/g) || []).length;
    const opens = (upto.match(/\u201C/g) || []).length;
    const closes = (upto.match(/\u201D/g) || []).length;
    if (straight % 2 === 1 || opens > closes) continue;

    out.push(text.slice(start, end).trim());
    start = end;
  }
  if (start < text.length) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

const SOURCE_TAG = /\[\s*S?\d+(?:\s*[,;]\s*S?\d+)*\s*\]/g;

function tagIds(tag: string): string[] {
  return [...tag.matchAll(/\d+/g)].map((d) => `S${d[0]}`);
}

/**
 * Apply all checks to `answer`. Returns the answer with failing sentences
 * removed, plus a full report of what was checked and why anything was dropped.
 */
export function enforceGrounding(
  answer: string,
  sources: GroundingSource[],
  supportingQuotes: { source?: unknown; text?: unknown }[] = [],
): GroundingReport {
  const corpus = sources.map((s) => `${s.title}\n${s.snippet}`).join("\n");
  const citeHay = pad(normCite(corpus));
  const wordHay = pad(normWords(corpus));
  const validIds = new Set(sources.map((s) => s.id.toUpperCase()));

  const found = extractCitations(answer);
  const citations: CitationCheck[] = found.map((c) => ({
    text: c.text,
    kind: c.kind,
    grounded: citeHay.includes(pad(c.key)),
  }));
  const ungrounded = found.filter((_, i) => !citations[i].grounded);

  const badQuotes = [...answer.matchAll(INLINE_QUOTE)]
    .map((m) => m[1])
    .filter((q) => quoteFragments(q).length > 0 && !containsQuote(wordHay, q));

  function reasonToRemove(sentence: string): string | null {
    const sentenceCite = pad(normCite(sentence));
    for (const c of ungrounded) {
      if (sentence.includes(c.text) || sentenceCite.includes(pad(c.key))) {
        return `Cites "${c.text}", which does not appear in your documents.`;
      }
    }
    for (const q of badQuotes) {
      if (sentence.includes(q)) {
        return "Quotes text that does not appear word-for-word in any of your documents.";
      }
    }
    const ids = [...sentence.matchAll(SOURCE_TAG)].flatMap((m) => tagIds(m[0]));
    if (ids.length && ids.every((id) => !validIds.has(id))) {
      return `Cites ${[...new Set(ids)].map((i) => `[${i}]`).join(", ")}, which is not one of the retrieved sources.`;
    }
    return null;
  }

  /** Drop references to sources that don't exist from tags that also cite real ones. */
  function cleanTags(sentence: string): string {
    return sentence
      .replace(SOURCE_TAG, (tag) => {
        const keep = tagIds(tag).filter((id) => validIds.has(id));
        return keep.length ? keep.map((id) => `[${id}]`).join("") : "";
      })
      .replace(/\s+([.,;:])/g, "$1");
  }

  const removed: Removal[] = [];
  const lines: string[] = [];
  let inFence = false;

  for (const line of answer.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    if (inFence || !line.trim()) {
      lines.push(line);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      // Table row: keep or drop whole.
      const reason = reasonToRemove(line);
      if (reason) removed.push({ sentence: line.trim(), reason });
      else lines.push(cleanTags(line));
      continue;
    }
    const m = line.match(/^(\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+)(.*)$/);
    const prefix = m ? m[1] : "";
    const body = m ? m[2] : line;
    const kept: string[] = [];
    for (const sentence of splitSentences(body)) {
      const reason = reasonToRemove(sentence);
      if (reason) removed.push({ sentence, reason });
      else kept.push(cleanTags(sentence));
    }
    if (kept.length) lines.push(prefix + kept.join(" "));
  }

  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text && removed.length) text = NOTHING_LEFT;

  return {
    text,
    removed,
    citations,
    quotes: checkSupportingQuotes(supportingQuotes, sources),
  };
}
