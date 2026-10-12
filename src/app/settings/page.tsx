"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import AppHeader from "@/components/AppHeader";
import AuthGate from "@/components/AuthGate";
import { applyDefaultTier, clearSavedConversations, type Tier } from "@/lib/chatStore";
import { api, errorMessage, supabase } from "@/lib/supabase";
import { getTheme, setTheme, type Theme } from "@/lib/theme";

interface Ai {
  defaultTier: Tier;
  fanout: number;
  topK: number;
  freeModels: string[];
  freeChecker: string;
  paidModel: string;
}
interface ModelOption {
  id: string;
  name: string;
}
type KeyName = "openrouter" | "gemini";
interface KeyStatus {
  source: "settings" | "supabase" | "missing";
  hint: string | null;
}
interface SettingsData {
  ai: Ai;
  keys: Record<KeyName, KeyStatus>;
  models: {
    options: { free: ModelOption[]; paid: ModelOption[] } | null;
    current: { free: { generators: string[]; checker: string }; paid: { generators: string[]; checker: string } };
  };
}

export default function SettingsPage() {
  return <AuthGate>{(session) => <Settings session={session} />}</AuthGate>;
}

function Settings({ session }: { session: Session }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await api("/settings");
      if (!res.ok) throw new Error(await errorMessage(res));
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-dvh">
      <AppHeader active="settings" />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <h1 className="text-lg font-semibold">Settings</h1>
        {error && <Alert tone="error">{error}</Alert>}

        <AppearanceCard />
        {data ? (
          <>
            <AiCard data={data} onSaved={setData} />
            <KeysCard data={data} onChanged={load} />
          </>
        ) : (
          !error && <p className="text-sm text-neutral-400">Loading…</p>
        )}
        <DeviceCard email={session.user.email ?? ""} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AppearanceCard() {
  const [theme, setChoice] = useState<Theme>("system");
  useEffect(() => setChoice(getTheme()), []);
  const options: { value: Theme; label: string }[] = [
    { value: "system", label: "Match my device" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <Card title="Appearance" note="Saved on this device.">
      <fieldset>
        <legend className="mb-2 text-sm text-neutral-600">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <label
              key={o.value}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
                theme === o.value ? "border-neutral-900 font-medium" : "border-neutral-200 text-neutral-600"
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={o.value}
                checked={theme === o.value}
                onChange={() => {
                  setChoice(o.value);
                  setTheme(o.value);
                }}
                className="sr-only"
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function AiCard({ data, onSaved }: { data: SettingsData; onSaved: (d: SettingsData) => void }) {
  const [ai, setAi] = useState<Ai>(data.ai);
  const [chooseFree, setChooseFree] = useState(data.ai.freeModels.length > 0 || data.ai.freeChecker !== "");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const options = data.models.options;
  const current = data.models.current;

  const update = (patch: Partial<Ai>) => {
    setAi((a) => ({ ...a, ...patch }));
    setStatus(null);
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    const body: Ai = chooseFree
      ? { ...ai, freeModels: ai.freeModels.slice(0, ai.fanout).filter(Boolean) }
      : { ...ai, freeModels: [], freeChecker: "" };
    try {
      const res = await api("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai: body }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const next = (await res.json()) as SettingsData;
      onSaved(next);
      setAi(next.ai);
      applyDefaultTier(next.ai.defaultTier);
      setStatus({ tone: "ok", text: "Saved. New questions use these settings." });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  const freeSlots = [0, 1, 2].slice(0, ai.fanout);
  const paidGroups = groupByProvider(options?.paid ?? []);

  return (
    <Card title="AI and answers" note="These apply to everyone who uses the app.">
      <form onSubmit={save} className="space-y-5">
        <Field label="Default answer mode" htmlFor="defaultTier">
          <select
            id="defaultTier"
            value={ai.defaultTier}
            onChange={(e) => update({ defaultTier: e.target.value as Tier })}
            className={SELECT}
          >
            <option value="free">Free — several free AI models draft and cross-check each answer</option>
            <option value="paid">Paid — your chosen paid model (billed to your OpenRouter account)</option>
          </select>
        </Field>

        <Field
          label="Drafting models per question (Free mode)"
          htmlFor="fanout"
          help="More models cross-check each other, but answers are slower and use more of OpenRouter's free daily allowance (each question uses this many requests, plus one for checking)."
        >
          <select id="fanout" value={ai.fanout} onChange={(e) => update({ fanout: Number(e.target.value) })} className={SELECT}>
            <option value={1}>1 — fastest, uses the least allowance</option>
            <option value={2}>2</option>
            <option value={3}>3 — most cross-checking (default)</option>
          </select>
        </Field>

        <Field
          label="Passages searched per question"
          htmlFor="topK"
          help="How many passages from your documents the AI reads for each question. More can help broad questions; fewer keeps answers focused."
        >
          <select id="topK" value={ai.topK} onChange={(e) => update({ topK: Number(e.target.value) })} className={SELECT}>
            {[4, 6, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 8 ? " (default)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Free models</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="freeMode" checked={!chooseFree} onChange={() => setChooseFree(false)} />
            Choose automatically (recommended)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="freeMode"
              checked={chooseFree}
              onChange={() => setChooseFree(true)}
              disabled={!options}
            />
            Let me choose
          </label>
          {!options && (
            <p className="text-xs text-neutral-500">The list of models isn&apos;t available right now, so they&apos;re chosen automatically.</p>
          )}
          {chooseFree && options && (
            <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
              {freeSlots.map((i) => (
                <Field key={i} label={`Drafting model ${i + 1}`} htmlFor={`free${i}`}>
                  <ModelSelect
                    id={`free${i}`}
                    value={ai.freeModels[i] ?? ""}
                    empty="Automatic"
                    options={options.free}
                    onChange={(v) => {
                      const next = [0, 1, 2].map((j) => ai.freeModels[j] ?? "");
                      next[i] = v;
                      update({ freeModels: next });
                    }}
                  />
                </Field>
              ))}
              <Field label="Checking model" htmlFor="freeChecker">
                <ModelSelect
                  id="freeChecker"
                  value={ai.freeChecker}
                  empty="Automatic"
                  options={options.free}
                  onChange={(v) => update({ freeChecker: v })}
                />
              </Field>
              <p className="text-xs text-neutral-500">
                If a chosen model stops being free, another free model is used automatically.
              </p>
            </div>
          )}
          <p className="text-xs text-neutral-500">
            Currently drafting with {current.free.generators.join(", ") || "—"}; checking with{" "}
            {current.free.checker || "—"}.
          </p>
        </fieldset>

        <Field
          label="Paid model"
          htmlFor="paidModel"
          help={`Currently: ${current.paid.generators[0] ?? "—"}. Paid answers use one model to draft and check, and are billed to your OpenRouter account (it needs credit).`}
        >
          <select
            id="paidModel"
            value={ai.paidModel}
            onChange={(e) => update({ paidModel: e.target.value })}
            className={SELECT}
          >
            <option value="">Automatic — newest Claude Sonnet</option>
            {ai.paidModel && !options?.paid.some((m) => m.id === ai.paidModel) && (
              <option value={ai.paidModel}>{ai.paidModel}</option>
            )}
            {paidGroups.map(([provider, models]) => (
              <optgroup key={provider} label={provider}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving} className={BUTTON}>
            {saving ? "Saving…" : "Save AI settings"}
          </button>
          {status && <Alert tone={status.tone}>{status.text}</Alert>}
        </div>
      </form>
    </Card>
  );
}

function groupByProvider(models: ModelOption[]): [string, ModelOption[]][] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const provider = m.id.split("/")[0];
    groups.set(provider, [...(groups.get(provider) ?? []), m]);
  }
  return [...groups.entries()];
}

function ModelSelect(props: {
  id: string;
  value: string;
  empty: string;
  options: ModelOption[];
  onChange: (v: string) => void;
}) {
  const known = props.options.some((m) => m.id === props.value);
  return (
    <select id={props.id} value={props.value} onChange={(e) => props.onChange(e.target.value)} className={SELECT}>
      <option value="">{props.empty}</option>
      {props.value && !known && <option value={props.value}>{props.value} (no longer free)</option>}
      {props.options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------

const KEY_INFO: Record<KeyName, { title: string; what: string; where: ReactNode; placeholder: string }> = {
  openrouter: {
    title: "OpenRouter key",
    what: "Lets the app use AI models to write answers.",
    where: (
      <>
        Get one at{" "}
        <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="text-blue-600 underline">
          openrouter.ai/settings/keys ↗
        </a>
        .
      </>
    ),
    placeholder: "sk-or-v1-…",
  },
  gemini: {
    title: "Google Gemini key",
    what: "Lets the app search your documents.",
    where: (
      <>
        Get one at{" "}
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-600 underline">
          aistudio.google.com ↗
        </a>
        . The daily document loader on GitHub keeps its own copy (the GEMINI_API_KEY GitHub secret).
      </>
    ),
    placeholder: "AIza…",
  },
};

function KeysCard({ data, onChanged }: { data: SettingsData; onChanged: () => Promise<void> }) {
  return (
    <Card
      title="API keys"
      note="Keys are tested before saving, stored encrypted in Supabase Vault, and never shown again — only their last four characters."
    >
      <div className="space-y-5">
        {(Object.keys(KEY_INFO) as KeyName[]).map((name) => (
          <KeyRow key={name} name={name} status={data.keys[name]} onChanged={onChanged} />
        ))}
      </div>
    </Card>
  );
}

function KeyRow({ name, status, onChanged }: { name: KeyName; status: KeyStatus; onChanged: () => Promise<void> }) {
  const info = KEY_INFO[name];
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function send(newValue: string | null, done: string) {
    setBusy(true);
    setResult(null);
    try {
      const res = await api("/settings/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value: newValue }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue("");
      await onChanged();
      setResult({ tone: "ok", text: done });
    } catch (e) {
      setResult({ tone: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const statusText = {
    settings: `Using the key saved here (${status.hint}).`,
    supabase: `Using the key from your Supabase secrets (${status.hint}).`,
    missing: "Not set — the app can't work without it.",
  }[status.source];

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium">{info.title}</div>
        <div className="text-xs text-neutral-500">
          {info.what} {info.where}
        </div>
      </div>
      <p
        data-testid={`${name}-status`}
        className={`text-sm ${status.source === "missing" ? "text-red-700" : "text-neutral-700"}`}
      >
        {statusText}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) send(value.trim(), "Key tested and saved. New questions use it.");
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`New ${info.title}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={status.source === "missing" ? info.placeholder : "Paste a new key to replace it"}
          className={`${INPUT} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy || !value.trim()} className={BUTTON}>
          {busy ? "Testing…" : "Save key"}
        </button>
        {status.source === "settings" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send(null, "Removed. The app now uses the key from your Supabase secrets, if there is one.")}
            className={BUTTON_SECONDARY}
          >
            Remove
          </button>
        )}
      </form>
      {result && <Alert tone={result.tone}>{result.text}</Alert>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeviceCard({ email }: { email: string }) {
  const [cleared, setCleared] = useState(false);
  return (
    <Card title="Account and this device">
      <div className="space-y-3 text-sm">
        <p>
          Signed in as <strong>{email}</strong>.
        </p>
        <p className="text-neutral-600">
          Your conversation is saved in this browser so it&apos;s still there when you come back. It&apos;s deleted
          from this device when you sign out.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              clearSavedConversations();
              setCleared(true);
            }}
            className={BUTTON_SECONDARY}
          >
            Clear saved conversation
          </button>
          <button onClick={() => supabase?.auth.signOut()} className={BUTTON_SECONDARY}>
            Sign out
          </button>
          {cleared && <Alert tone="ok">Cleared.</Alert>}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const INPUT = "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500";
const SELECT = `${INPUT} w-full`;
const BUTTON = "rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40";
const BUTTON_SECONDARY =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 disabled:opacity-40";

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {note && <p className="mb-3 text-xs text-neutral-500">{note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Field({ label, htmlFor, help, children }: { label: string; htmlFor: string; help?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-neutral-500">{help}</p>}
    </div>
  );
}

function Alert({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-xs ${
        tone === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-700"
      }`}
    >
      {children}
    </p>
  );
}
