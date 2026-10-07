"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { BASE_PATH, configured, supabase } from "@/lib/supabase";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

/**
 * Email magic-link sign-in. The site itself is public (github.io), so nothing
 * is shown — and the API refuses every request — until a signed-in user whose
 * email is on the server's ALLOWED_EMAILS list is present.
 */
export default function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    // A failed or expired magic link comes back with the reason in the URL hash.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const err = hash.get("error_description");
    if (err) {
      setStatus({ kind: "error", message: err.replace(/\+/g, " ") });
      history.replaceState(null, "", window.location.pathname);
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured) {
    return (
      <Centered>
        <p className="text-sm text-red-700">
          This build is missing <code>NEXT_PUBLIC_SUPABASE_URL</code> /{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
        </p>
      </Centered>
    );
  }
  if (!ready) {
    return (
      <Centered>
        <p className="text-sm text-neutral-400">Loading…</p>
      </Centered>
    );
  }
  if (session) return <>{children(session)}</>;

  async function send(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setStatus({ kind: "sending" });
    const { error } = await supabase!.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: `${window.location.origin}${BASE_PATH}/` },
    });
    setStatus(error ? { kind: "error", message: error.message } : { kind: "sent", email: address });
  }

  return (
    <Centered>
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-base font-semibold">Research Fact Base</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Answers drawn only from your documents, with every citation and quote checked.
        </p>

        {status.kind === "sent" ? (
          <div className="mt-5 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            Check <strong>{status.email}</strong> for a sign-in link. Open it in this browser.
          </div>
        ) : (
          <form onSubmit={send} className="mt-5 space-y-3">
            <label className="block text-xs font-medium text-neutral-600" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              placeholder="you@example.com"
            />
            <button
              type="submit"
              disabled={status.kind === "sending"}
              className="w-full rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {status.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        {status.kind === "error" && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {status.message}
          </p>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-4">{children}</div>;
}
