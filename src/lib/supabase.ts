import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Public values, baked in at build time. The publishable key is designed to be
// exposed: it grants nothing on its own (tables are RLS-locked, and the API
// requires a signed-in, allowlisted user).
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const configured = Boolean(url && key);
export const supabase: SupabaseClient | null = configured ? createClient(url, key) : null;
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? "";

const API = `${url}/functions/v1/research-api`;

/** Call the research-api edge function with the current (auto-refreshed) session token. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase!.auth.getSession();
  const token = data.session?.access_token;
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      apikey: key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/** Readable message from a failed edge-function response. */
export async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) return String(parsed.error);
    if (parsed?.message) return String(parsed.message);
  } catch {
    // not JSON
  }
  if (res.status === 404) return "The research service isn't deployed yet.";
  return `Request failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ""}`;
}
