import { supabaseAdmin } from "@/lib/supabase/server";
import type { CitationVerification } from "@/lib/types";

const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function normalizeCitation(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function getCached(
  provider: string,
  citation: string,
): Promise<CitationVerification | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;

  const citation_key = `${provider}:${normalizeCitation(citation)}`;
  const { data } = await supabase
    .from("verification_cache")
    .select("result, fetched_at")
    .eq("citation_key", citation_key)
    .maybeSingle();

  if (!data) return null;
  if (Date.now() - new Date(data.fetched_at as string).getTime() > TTL_MS) return null;
  return data.result as CitationVerification;
}

export async function setCached(
  provider: string,
  citation: string,
  result: CitationVerification,
): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;

  const citation_key = `${provider}:${normalizeCitation(citation)}`;
  await supabase
    .from("verification_cache")
    .upsert({ citation_key, provider, result, fetched_at: new Date().toISOString() });
}
