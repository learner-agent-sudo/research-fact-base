import type { Source } from "@/lib/types";

/**
 * RAG retrieval over the designated Google Drive corpus.
 *
 * Phase 1 (TODO): embed the query with Voyage, call the Supabase `match_chunks`
 * RPC (pgvector cosine search), and map the top-k chunks to Source objects with
 * their Drive document links. Returns [] until Supabase + embeddings are wired,
 * so the app runs today and the checker will simply report insufficient sources.
 */
export async function retrieve(_query: string): Promise<Source[]> {
  return [];
}
