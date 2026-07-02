export interface Chunk {
  content: string;
  index: number;
  tokenEstimate: number;
}

// ~600 tokens target with ~75 tokens overlap (approx 4 chars/token).
const TARGET_CHARS = Math.max(400, Number(process.env.CHUNK_TARGET_CHARS || 2400));
const OVERLAP_CHARS = Math.max(0, Number(process.env.CHUNK_OVERLAP_CHARS || 300));

/**
 * Paragraph-aware chunker with overlap. Accumulates paragraphs up to a target
 * size, carries a small overlap tail into the next chunk for context continuity,
 * and hard-splits any single oversized paragraph so nothing exceeds the budget.
 */
export function chunkText(text: string): Chunk[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
  };

  for (const raw of paras) {
    const para = raw.trim();
    if (!para) continue;

    if (cur && cur.length + para.length + 2 > TARGET_CHARS) {
      flush();
      const tail = cur.slice(Math.max(0, cur.length - OVERLAP_CHARS));
      cur = `${tail}\n\n${para}`;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }

    // Hard-split a very long accumulation.
    while (cur.length > TARGET_CHARS * 1.5) {
      chunks.push(cur.slice(0, TARGET_CHARS).trim());
      cur = cur.slice(TARGET_CHARS - OVERLAP_CHARS);
    }
  }
  flush();

  return chunks.map((content, index) => ({
    content,
    index,
    tokenEstimate: Math.ceil(content.length / 4),
  }));
}
