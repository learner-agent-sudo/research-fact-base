/**
 * Embedding provider abstraction. Auto-selects by configured key:
 *   - GEMINI_API_KEY  → Gemini (free tier, no payment card needed) — default
 *   - VOYAGE_API_KEY  → Voyage (voyage-law-2; fastest with billing enabled)
 * Override with EMBEDDINGS_PROVIDER=gemini|voyage. Both output vectors matching
 * the DB schema's vector(1024) (Gemini via outputDimensionality).
 *
 * NOTE: embeddings from different providers live in different vector spaces.
 * If you switch providers after ingesting, re-embed the corpus
 * (UPDATE chunks SET embedding = NULL; then run a sync).
 */

import { geminiConfigured, geminiEmbedDocuments, geminiEmbedQuery } from "./gemini";
import {
  embedDocuments as voyageEmbedDocuments,
  embedQuery as voyageEmbedQuery,
  embeddingsConfigured as voyageConfigured,
} from "./voyage";

export { toVectorLiteral } from "./voyage";

type Provider = "gemini" | "voyage" | null;

function provider(): Provider {
  const forced = (process.env.EMBEDDINGS_PROVIDER || "").toLowerCase();
  if (forced === "gemini") return geminiConfigured() ? "gemini" : null;
  if (forced === "voyage") return voyageConfigured() ? "voyage" : null;
  if (geminiConfigured()) return "gemini";
  if (voyageConfigured()) return "voyage";
  return null;
}

export function embeddingsConfigured(): boolean {
  return provider() !== null;
}

export function embeddingsProviderName(): string {
  return provider() ?? "none";
}

export function embedDocuments(texts: string[]): Promise<number[][]> {
  const p = provider();
  if (p === "gemini") return geminiEmbedDocuments(texts);
  if (p === "voyage") return voyageEmbedDocuments(texts);
  throw new Error("No embedding provider configured (set GEMINI_API_KEY or VOYAGE_API_KEY)");
}

export function embedQuery(text: string): Promise<number[]> {
  const p = provider();
  if (p === "gemini") return geminiEmbedQuery(text);
  if (p === "voyage") return voyageEmbedQuery(text);
  throw new Error("No embedding provider configured (set GEMINI_API_KEY or VOYAGE_API_KEY)");
}
