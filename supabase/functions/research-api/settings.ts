/**
 * App-wide settings and API keys, managed from the website's Settings page.
 *
 *   - AI settings live in the `app_settings` table (row 'ai'); the document
 *     loader writes its last run to row 'library'.
 *   - API keys entered on the Settings page are stored encrypted in Supabase
 *     Vault (via the app_secret_get / app_secret_set functions, which only the
 *     service role may call). They are never sent back to the browser.
 *
 * Runtime-agnostic (web fetch only), like pipeline.ts.
 */

import { serviceHeaders, type Tier } from "./pipeline.ts";

export interface AiSettings {
  defaultTier: Tier;
  /** Drafting models per free-tier question (1-3). */
  fanout: number;
  /** Passages retrieved per question. */
  topK: number;
  /** Free models chosen on the Settings page; empty = automatic. */
  freeModels: string[];
  /** Preferred free checker; "" = automatic. */
  freeChecker: string;
  /** Paid model; "" = automatic (newest Claude Sonnet). */
  paidModel: string;
}

export const DEFAULT_AI: AiSettings = {
  defaultTier: "free",
  fanout: 3,
  topK: 8,
  freeModels: [],
  freeChecker: "",
  paidModel: "",
};

export const TOP_K_CHOICES = [4, 6, 8, 10, 12];
const MODEL_ID = /^[\w.-]+\/[\w.:-]+$/;

/** Checks a Settings-page submission; returns the cleaned settings or an error message. */
export function validateAi(input: unknown): AiSettings | string {
  const b = (input ?? {}) as Record<string, unknown>;
  const out: AiSettings = { ...DEFAULT_AI };

  if (b.defaultTier !== undefined) {
    if (b.defaultTier !== "free" && b.defaultTier !== "paid") return "Default answer mode must be free or paid.";
    out.defaultTier = b.defaultTier;
  }
  if (b.fanout !== undefined) {
    if (!Number.isInteger(b.fanout) || (b.fanout as number) < 1 || (b.fanout as number) > 3) {
      return "Drafting models must be 1, 2 or 3.";
    }
    out.fanout = b.fanout as number;
  }
  if (b.topK !== undefined) {
    if (!TOP_K_CHOICES.includes(b.topK as number)) return `Passages per question must be one of ${TOP_K_CHOICES.join(", ")}.`;
    out.topK = b.topK as number;
  }
  if (b.freeModels !== undefined) {
    if (!Array.isArray(b.freeModels) || b.freeModels.length > 3) return "Choose at most 3 free models.";
    const ids = b.freeModels.filter((m) => m !== "" && m !== null);
    if (!ids.every((m) => typeof m === "string" && MODEL_ID.test(m))) return "Unrecognised model name.";
    out.freeModels = [...new Set(ids as string[])];
  }
  for (const key of ["freeChecker", "paidModel"] as const) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "string" || (b[key] !== "" && !MODEL_ID.test(b[key] as string))) {
      return "Unrecognised model name.";
    }
    out[key] = b[key] as string;
  }
  return out;
}

export interface LibraryStatus {
  folderId?: string;
  finishedAt?: string;
  loaded?: number;
  unchanged?: number;
  skipped?: number;
  removed?: number;
  errored?: number;
  stoppedEarly?: boolean;
}

async function readRows(base: string, key: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/rest/v1/app_settings?select=key,value&key=in.(ai,library)`, {
    headers: serviceHeaders(key),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return {}; // table missing or unreachable: fall back to defaults
  }
  const rows = (await res.json()) as { key: string; value: unknown }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Saved AI settings (null if never saved on the Settings page), plus the loader's last run. */
export async function loadSettings(
  base: string,
  key: string,
): Promise<{ ai: AiSettings | null; library: LibraryStatus }> {
  const rows = await readRows(base, key);
  const saved = rows.ai === undefined ? null : validateAi(rows.ai);
  return {
    ai: saved === null || typeof saved === "string" ? null : saved,
    library: (rows.library ?? {}) as LibraryStatus,
  };
}

export async function saveAi(base: string, key: string, ai: AiSettings, by: string): Promise<void> {
  const res = await fetch(`${base}/rest/v1/app_settings`, {
    method: "POST",
    headers: { ...serviceHeaders(key), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "ai", value: ai, updated_at: new Date().toISOString(), updated_by: by }),
  });
  if (!res.ok) throw new Error(`Could not save settings (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export type KeyName = "openrouter" | "gemini";
export const KEY_NAMES: KeyName[] = ["openrouter", "gemini"];
const VAULT_NAME: Record<KeyName, string> = {
  openrouter: "rfb_openrouter_api_key",
  gemini: "rfb_gemini_api_key",
};

async function rpc(base: string, key: string, fn: string, args: Record<string, unknown>): Promise<Response> {
  return await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: serviceHeaders(key),
    body: JSON.stringify(args),
  });
}

/** The key saved on the Settings page, or null if none (or Vault is unavailable). */
export async function storedKey(base: string, key: string, name: KeyName): Promise<string | null> {
  try {
    const res = await rpc(base, key, "app_secret_get", { p_name: VAULT_NAME[name] });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const value = await res.json();
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Saves (or, with null, removes) a key in Vault. */
export async function storeKey(base: string, key: string, name: KeyName, value: string | null): Promise<void> {
  const res = await rpc(base, key, "app_secret_set", { p_name: VAULT_NAME[name], p_value: value });
  if (!res.ok) throw new Error(`Could not save the key (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  await res.body?.cancel();
}

/** Last four characters only — enough to recognise a key, useless to anyone else. */
export function keyHint(value: string): string {
  return value.length > 8 ? `••••${value.slice(-4)}` : "••••";
}

/**
 * Tries a key before saving it. Returns null if it works, or a message saying
 * why not. Network trouble or rate limits don't count against the key.
 */
export async function testKey(name: KeyName, value: string, embedModel: string, embedDim: number): Promise<string | null> {
  try {
    if (name === "openrouter") {
      for (const path of ["/api/v1/key", "/api/v1/auth/key"]) {
        const res = await fetch(`https://openrouter.ai${path}`, { headers: { Authorization: `Bearer ${value}` } });
        await res.body?.cancel();
        if (res.ok) return null;
        if (res.status === 401 || res.status === 403) return "OpenRouter rejected this key. Check you copied all of it.";
        if (res.status !== 404) return null;
      }
      return null;
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${embedModel}:embedContent`, {
      method: "POST",
      headers: { "x-goog-api-key": value, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${embedModel}`,
        content: { parts: [{ text: "key check" }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: embedDim,
      }),
    });
    const text = await res.text();
    if (res.ok || res.status === 429) return null;
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return /API_KEY|api key|permission/i.test(text) || res.status !== 400
        ? "Google rejected this key. Check you copied all of it, and that it's a Gemini API key from aistudio.google.com."
        : `Google returned an error for this key: ${text.slice(0, 160)}`;
    }
    return null;
  } catch {
    return null;
  }
}
