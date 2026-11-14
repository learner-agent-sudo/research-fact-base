/**
 * The conversation, kept outside React so it survives moving between pages
 * (an answer in progress keeps arriving while you're on Settings), and saved
 * in this browser's localStorage so it survives a reload. Saved per user, and
 * deleted from the device on sign-out.
 */
import { useSyncExternalStore } from "react";
import { api, errorMessage, supabase } from "./supabase";

export type Tier = "free" | "paid";
export type Confidence = "high" | "medium" | "low";
export type Stage = "retrieving" | "drafting" | "checking" | "verifying";

export interface Source {
  id: string;
  title: string;
  url?: string;
  snippet: string;
  similarity?: number;
}
export interface CitationCheck {
  text: string;
  kind: string;
  grounded: boolean;
}
export interface QuoteCheck {
  source: string;
  text: string;
  status: "verified" | "misattributed" | "not_found";
  foundIn?: string;
}
export interface Removal {
  sentence: string;
  reason: string;
}

export interface Msg {
  role: "user" | "assistant";
  content: string;
  stage?: Stage;
  sources?: Source[];
  generators?: string[];
  checker?: string;
  tier?: Tier;
  citations?: CitationCheck[];
  quotes?: QuoteCheck[];
  removed?: Removal[];
  confidence?: Confidence;
  unsupported?: string[];
  pending?: boolean;
  /** When the answer was requested (ms since epoch), to show how long it's taking. */
  startedAt?: number;
  /** Shown while the answer is pending, e.g. while it's being asked again. */
  note?: string;
  error?: string;
}

interface ChatState {
  userId: string | null;
  messages: Msg[];
  tier: Tier;
  /** True once the user picks a tier this session, so the saved default no longer overrides it. */
  tierChosen: boolean;
  busy: boolean;
}

const PREFIX = "rfb.chat.v1.";
const MAX_SAVED = 40; // messages kept on the device (20 questions and answers)
export const INTERRUPTED =
  "This answer was interrupted because the page was closed or reloaded before it finished. Please ask again.";
export const STOPPED = "You stopped this answer.";
export const STALLED =
  "The research service stopped responding, so this answer was abandoned. Please ask again, or switch to Paid.";
export const TOO_LONG = "This answer took more than 3 minutes, so it was stopped. Please ask again, or switch to Paid.";
export const INCOMPLETE = "The answer stopped before it finished. Please ask again.";
export const RETRYING =
  "This research server was near its time limit, so the question is being asked again on a fresh one…";

// The server sends a keep-alive every 10 seconds while it works, and always
// finishes within about 2 minutes, so these only trip if something is wrong.
// (The browser tests shorten them via window.__rfbChatLimits.)
function limits() {
  const override = (globalThis as { __rfbChatLimits?: { stallMs?: number; maxMs?: number } }).__rfbChatLimits;
  return { stallMs: 45_000, maxMs: 180_000, ...override };
}

const INITIAL: ChatState = { userId: null, messages: [], tier: "free", tierChosen: false, busy: false };
let state: ChatState = INITIAL;
let epoch = 0; // bumped whenever the conversation is replaced, so stale answers are dropped
/** Cancels the answer in progress, if any, showing the given message. */
let cancel: ((why: string) => void) | null = null;
const listeners = new Set<() => void>();

function persist() {
  if (!state.userId) return;
  let keep = state.messages.slice(-MAX_SAVED);
  for (;;) {
    try {
      if (keep.length) localStorage.setItem(PREFIX + state.userId, JSON.stringify(keep));
      else localStorage.removeItem(PREFIX + state.userId);
      return;
    } catch {
      if (!keep.length) return; // storage unavailable
      keep = keep.slice(Math.ceil(keep.length / 2)); // storage full: keep the newer half
    }
  }
}

// A reload or closed tab cancels the answer's download; say so plainly rather
// than saving the browser's "Failed to fetch".
let leaving = false;
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => (leaving = true));
  window.addEventListener("pageshow", () => (leaving = false));
}

function describeFailure(e: unknown): string {
  if (leaving) return INTERRUPTED;
  const message = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed|network connection was lost/i.test(message)
    ? "Couldn't reach the research service. Check your internet connection and ask again."
    : message;
}

function set(patch: Partial<ChatState>) {
  state = { ...state, ...patch };
  persist();
  listeners.forEach((l) => l());
}

export function useChat(): ChatState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => INITIAL,
  );
}

/** Loads this user's saved conversation (once per sign-in). */
export function attachUser(userId: string) {
  if (state.userId === userId) return;
  let messages: Msg[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem(PREFIX + userId) ?? "[]");
    if (Array.isArray(saved)) messages = saved;
  } catch {
    // unreadable: start fresh
  }
  messages = messages.map((m) => (m.pending ? { ...m, pending: false, note: undefined, error: m.error ?? INTERRUPTED } : m));
  epoch++;
  set({ userId, messages, busy: false, tierChosen: false });
}

export function applyDefaultTier(tier: Tier) {
  if (!state.tierChosen && state.tier !== tier) set({ tier });
}

export function chooseTier(tier: Tier) {
  set({ tier, tierChosen: true });
}

export function newConversation() {
  if (state.busy) return;
  epoch++;
  set({ messages: [] });
}

/** Forgets every saved conversation on this device. */
export function clearSavedConversations() {
  cancel?.(INTERRUPTED);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    // storage unavailable
  }
  epoch++;
  state = { ...state, messages: [], busy: false };
  listeners.forEach((l) => l());
}

supabase?.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    clearSavedConversations();
    state = { ...INITIAL };
    listeners.forEach((l) => l());
  }
});

/** Prior turns sent as context: only completed, verified answers. */
function history(list: Msg[]) {
  return list.filter((m) => m.content && !m.error && !m.pending).map((m) => ({ role: m.role, content: m.content }));
}

export function ask(question: string) {
  const q = question.trim();
  if (!q || state.busy) return;
  const turns = [...history(state.messages), { role: "user", content: q }];
  set({ messages: [...state.messages, { role: "user", content: q }] });
  void run(turns, state.tier);
}

export function stopAnswer() {
  cancel?.(STOPPED);
}

export function rerunWithPaid() {
  const lastUser = state.messages.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0 || state.busy) return;
  void run(history(state.messages.slice(0, lastUser + 1)), "paid");
}

async function run(turns: { role: string; content: string }[], tier: Tier) {
  const myEpoch = epoch;
  const index = state.messages.length;
  const patch = (p: Partial<Msg>) => {
    if (epoch !== myEpoch || !state.messages[index]) return;
    const messages = [...state.messages];
    messages[index] = { ...messages[index], ...p };
    set({ messages });
  };

  set({
    messages: [...state.messages, { role: "assistant", content: "", pending: true, tier, startedAt: Date.now() }],
    busy: true,
  });

  // Give up if the service goes quiet or takes far too long, rather than waiting forever.
  const controller = new AbortController();
  let reason: string | null = null;
  const giveUp = (why: string) => {
    reason ??= why;
    controller.abort();
  };
  cancel = giveUp;
  const { stallMs, maxMs } = limits();
  let stall: ReturnType<typeof setTimeout> | undefined;
  let overall: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(stall);
    stall = setTimeout(() => giveUp(STALLED), stallMs);
  };
  const startTimers = () => {
    clearTimeout(overall);
    alive();
    overall = setTimeout(() => giveUp(TOO_LONG), maxMs);
  };
  const stopTimers = () => {
    clearTimeout(stall);
    clearTimeout(overall);
  };

  // Waits `ms`, but rejects at once if the answer is given up on (Stop, reload, timeouts).
  const pause = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) return reject(controller.signal.reason);
      const onAbort = () => {
        clearTimeout(t);
        reject(controller.signal.reason);
      };
      const t = setTimeout(() => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });

  // One request and its answer. On the first attempt, returns how long to wait before
  // asking again when the server ran out of time on an old worker (null otherwise).
  const once = async (first: boolean): Promise<number | null> => {
    const res = await api("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: turns, tier }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorMessage(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    let retryAfterMs: number | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      alive();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        switch (ev.type) {
          case "stage":
            patch({ stage: ev.stage as Stage });
            break;
          case "sources":
            patch({ sources: ev.sources as Source[] });
            break;
          case "meta":
            patch({ generators: ev.generators as string[], checker: ev.checker as string, tier: ev.tier as Tier });
            break;
          case "final":
            patch({
              content: ev.text as string,
              removed: ev.removed as Removal[],
              citations: ev.citations as CitationCheck[],
              quotes: ev.quotes as QuoteCheck[],
              checker: (ev.checker as string) || undefined,
            });
            break;
          case "done":
            finished = true;
            patch({
              confidence: ev.confidence as Confidence,
              unsupported: ev.unsupported as string[],
              pending: false,
              note: undefined,
            });
            break;
          case "error":
            finished = true;
            if (first && typeof ev.retryAfterMs === "number") {
              retryAfterMs = ev.retryAfterMs;
              break; // not shown: the question is asked again
            }
            patch({ error: ev.message as string, pending: false, note: undefined });
            break;
        }
      }
    }
    if (retryAfterMs !== null) return retryAfterMs;
    patch(finished ? { pending: false, note: undefined } : { error: INCOMPLETE, pending: false, note: undefined });
    return null;
  };

  startTimers();
  try {
    const retryAfter = await once(true);
    if (retryAfter !== null) {
      // The old worker is about to stop, so a fresh one is asked: at most one retry.
      patch({ note: RETRYING, stage: undefined, sources: undefined, generators: undefined, checker: undefined });
      stopTimers();
      await pause(Math.min(retryAfter, 20_000));
      startTimers();
      await once(false);
    }
  } catch (e) {
    if (epoch === myEpoch) patch({ error: reason ?? describeFailure(e), pending: false, note: undefined });
  } finally {
    stopTimers();
    if (cancel === giveUp) cancel = null;
    if (epoch === myEpoch) set({ busy: false });
  }
}
