/**
 * Voyage AI embeddings. Default model `voyage-law-2` is domain-tuned for legal
 * text and outputs 1024 dimensions — matching the `vector(1024)` schema column.
 * If you change the model, keep the dimension in sync with the DB.
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const MODEL = process.env.VOYAGE_MODEL || "voyage-law-2";
const BATCH = 32; // Voyage accepts many inputs per call; keep batches modest.

export function embeddingsConfigured(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

async function embed(inputs: string[], inputType: "document" | "query"): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");

  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: batch, model: MODEL, input_type: inputType }),
    });
    if (!res.ok) {
      throw new Error(`Voyage error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = await res.json();
    const items = (data.data as { embedding: number[]; index: number }[]).sort(
      (a, b) => a.index - b.index,
    );
    for (const it of items) out.push(it.embedding);
  }
  return out;
}

export function embedDocuments(texts: string[]): Promise<number[][]> {
  return embed(texts, "document");
}

export async function embedQuery(text: string): Promise<number[]> {
  return (await embed([text], "query"))[0];
}

/** pgvector text literal for a vector column value or function argument. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
