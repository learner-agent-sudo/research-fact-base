import { embedQuery, embeddingsConfigured, toVectorLiteral } from "@/lib/embeddings";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { Source } from "@/lib/types";

const TOP_K = Math.max(1, Number(process.env.RETRIEVAL_TOP_K || 8));

interface MatchRow {
  content: string;
  title: string | null;
  drive_file_id: string | null;
  similarity: number;
}

/**
 * RAG retrieval over the designated Google Drive corpus: embed the query with
 * Voyage, run pgvector cosine search via the `match_chunks` RPC, and map the
 * top-k chunks to Source objects (with their Drive links). Returns [] when
 * Supabase or embeddings aren't configured, so the app still runs.
 */
export async function retrieve(query: string): Promise<Source[]> {
  const supabase = supabaseAdmin();
  if (!supabase || !embeddingsConfigured() || !query.trim()) return [];

  try {
    const embedding = await embedQuery(query);
    const { data, error } = await supabase.rpc("match_chunks", {
      query_embedding: toVectorLiteral(embedding),
      match_count: TOP_K,
    });
    if (error || !Array.isArray(data)) return [];

    return (data as MatchRow[]).map((row, i) => ({
      id: `S${i + 1}`, // re-tagged sequentially by the pipeline once merged with web sources
      type: "drive" as const,
      title: row.title || "document",
      url: row.drive_file_id
        ? `https://drive.google.com/file/d/${row.drive_file_id}/view`
        : undefined,
      snippet: String(row.content || "").slice(0, 1500),
    }));
  } catch {
    return [];
  }
}
