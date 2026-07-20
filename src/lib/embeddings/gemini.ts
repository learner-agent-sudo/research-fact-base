/**
 * Gemini embeddings (gemini-embedding-001) via the Generative Language API.
 * Free API keys from aistudio.google.com work with no payment method — the
 * card-free alternative to Voyage. outputDimensionality is truncated via MRL,
 * so we request the schema's 1024 dims and re-normalize client-side (recommended
 * for truncated Gemini embeddings; cosine search is unaffected either way).
 */

const MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const DIM = Math.max(1, Number(process.env.EMBEDDING_DIM || 1024));
const BATCH = 16;

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

async function embed(
  inputs: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`;
  const out: number[][] = [];

  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: batch.map((text) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: DIM,
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Gemini embeddings error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as { embeddings?: { values: number[] }[] };
    if (!data.embeddings || data.embeddings.length !== batch.length) {
      throw new Error("Gemini embeddings: unexpected response shape");
    }
    for (const e of data.embeddings) out.push(normalize(e.values));
  }
  return out;
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return v;
  return v.map((x) => x / norm);
}

export function geminiEmbedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "RETRIEVAL_DOCUMENT");
}

export async function geminiEmbedQuery(text: string): Promise<number[]> {
  return (await embed([text], "RETRIEVAL_QUERY"))[0];
}
