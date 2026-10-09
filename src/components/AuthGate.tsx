"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { BASE_PATH, api, configured, errorMessage, supabase } from "@/lib/supabase";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "verifying"; email: string };

type Access = { kind: "checking" } | { kind: "ok" } | { kind: "denied"; message: string };

/**
 * Turns Supabase Auth errors into instructions a person can act on. Codes:
 * https://supabase.com/docs/guides/auth/debugging/error-codes
 */
export function describeAuthError(code: string | undefined, message: string): string {
  if (code === "otp_expired" || /invalid or has expired|token has expired/i.test(message)) {
    return (
      "That sign-in link or code has expired or was already used. Each one works only once, and only " +
      "the newest email is valid. Request a new link below."
    );
  }
  if (code === "over_email_send_rate_limit" || /rate limit/i.test(message)) {
    return (
      "Too many sign-in emails were sent recently (Supabase's free email service only sends a few per " +
      "hour). Use the newest email you already have, or try again later."
    );
  }
  const wait = message.match(/after (\d+) seconds?/i);
  if (code === "over_request_rate_limit" || wait) {
    return `Please wait ${wait ? `${wait[1]} seconds` : "a minute"} before requesting another email.`;
  }
  if (code === "signup_disabled" || /signups not allowed/i.test(message)) {
    return "This email isn't registered for this app.";
  }
  return message;
}

/**
 * Email sign-in (magic link, or the one-time code from the same email). The
 * site is public (github.io), so nothing is shown — and the API refuses every
 * request — until a signed-in user whose email is on the server's
 * ALLOWED_EMAILS list is present.
 */
export default function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<Access>({ kind: "checking" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setReady(true);
      return;
    }
    // A failed or expired email link comes back with the reason in the URL hash
    // (or query string), e.g. #error=access_denied&error_code=otp_expired.
    const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
    const description = params.get("error_description");
    if (params.get("error") || description) {
      setError(describeAuthError(params.get("error_code") ?? undefined, description ?? "Sign-in failed."));
      history.replaceState(null, "", window.location.pathname);
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // Signed in is not the same as allowed: ask the API before showing the app,
  // so a wrong account or missing server setting is explained up front.
  const checkAccess = useCallback(async () => {
    setAccess({ kind: "checking" });
    try {
      const res = await api("/me");
      if (res.ok) return setAccess({ kind: "ok" });
      const message = await errorMessage(res);
      if (res.status === 401) {
        await supabase!.auth.signOut();
        setError(message);
        return;
      }
      setAccess({ kind: "denied", message });
    } catch (e) {
      setAccess({
        kind: "denied",
        message: `Couldn't reach the research service (${e instanceof Error ? e.message : String(e)}).`,
      });
    }
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (userId) checkAccess();
  }, [userId, checkAccess]);

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
  if (!ready || (session && access.kind === "checking")) {
    return (
      <Centered>
        <p className="text-sm text-neutral-400">Loading…</p>
      </Centered>
    );
  }
  if (session && access.kind === "ok") return <>{children(session)}</>;
  if (session && access.kind === "denied") {
    return (
      <Centered>
        <Card>
          <p className="text-sm text-neutral-700">
            Signed in as <strong>{session.user.email}</strong>, but the app can&apos;t be used yet:
          </p>
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {access.message}
          </p>
          <div className="mt-4 flex gap-2">
            <button onClick={checkAccess} className={BUTTON}>
              Try again
            </button>
            <button onClick={() => supabase!.auth.signOut()} className={BUTTON_SECONDARY}>
              Sign out
            </button>
          </div>
        </Card>
      </Centered>
    );
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const address = email.trim();
    if (!address) return;
    setError("");
    setStatus({ kind: "sending" });
    const { error } = await supabase!.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: `${window.location.origin}${BASE_PATH}/` },
    });
    if (error) {
      setError(describeAuthError(error.code, error.message));
      setStatus({ kind: "idle" });
    } else {
      setCode("");
      setStatus({ kind: "sent", email: address });
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (status.kind !== "sent") return;
    const token = code.replace(/\s/g, "");
    if (!/^\d{6,10}$/.test(token)) {
      setError("Enter the number from the email (digits only).");
      return;
    }
    setError("");
    setStatus({ kind: "verifying", email: status.email });
    const { error } = await supabase!.auth.verifyOtp({ email: status.email, token, type: "email" });
    if (error) setError(describeAuthError(error.code, error.message));
    setStatus({ kind: "sent", email: status.email });
  }

  return (
    <Centered>
      <Card>
        <h1 className="text-base font-semibold">Research Fact Base</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Answers drawn only from your documents, with every citation and quote checked.
        </p>

        {status.kind === "sent" || status.kind === "verifying" ? (
          <div className="mt-5 space-y-3">
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              Sent! Check <strong>{status.email}</strong> (and the spam folder).
            </div>
            <ul className="list-disc space-y-1 pl-4 text-xs text-neutral-600">
              <li>Click the link in the email on the device where you want to use the app.</li>
              <li>Each link works once — if you asked for several emails, use the newest.</li>
            </ul>
            <form onSubmit={verify} className="space-y-2">
              <label className="block text-xs font-medium text-neutral-600" htmlFor="code">
                Or, if the email shows a code, enter it here:
              </label>
              <div className="flex gap-2">
                <input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={`${INPUT} tracking-widest`}
                  placeholder="123456"
                />
                <button type="submit" disabled={status.kind === "verifying"} className={`${BUTTON} shrink-0`}>
                  {status.kind === "verifying" ? "Checking…" : "Sign in"}
                </button>
              </div>
            </form>
            <button
              onClick={() => {
                setError("");
                setStatus({ kind: "idle" });
              }}
              className="text-xs text-neutral-500 underline"
            >
              Use a different email or send a new link
            </button>
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
              className={INPUT}
              placeholder="you@example.com"
            />
            <button type="submit" disabled={status.kind === "sending"} className={`${BUTTON} w-full`}>
              {status.kind === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
      </Card>
    </Centered>
  );
}

const INPUT =
  "w-full min-w-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500";
const BUTTON =
  "rounded-lg bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40";
const BUTTON_SECONDARY = "rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700";

function Card({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">{children}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-4">{children}</div>;
}
