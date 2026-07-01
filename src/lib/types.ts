export type Tier = "free" | "paid";

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Source {
  id: string; // stable tag used in the answer, e.g. "S1"
  type: "drive" | "web" | "upload";
  title: string;
  url?: string;
  snippet: string; // the text the model is allowed to ground on
}

export interface GeneratorDraft {
  model: string;
  content: string;
  error?: string;
}

export type Confidence = "high" | "medium" | "low";

export interface CheckerMeta {
  confidence: Confidence;
  unsupported: string[]; // claims dropped or flagged as unverified
}

// NDJSON events streamed from POST /api/chat
export type StreamEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "meta"; tier: Tier; generators: string[]; checker: string }
  | { type: "delta"; text: string }
  | { type: "done"; confidence: Confidence; unsupported: string[] }
  | { type: "error"; message: string };
