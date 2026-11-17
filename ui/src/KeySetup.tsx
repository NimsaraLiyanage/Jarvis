import { useState, type FormEvent } from "react";
import type { KeyStatus } from "./useJarvis";

const CORE_HTTP = import.meta.env.VITE_CORE_HTTP ?? "http://127.0.0.1:8765";
const KEYS_PAGE = "https://platform.openai.com/api-keys";

// Asks for the user's own OpenAI key. The core checks it with OpenAI and keeps
// it encrypted for this Windows account; the key never stays in the UI.
export function KeySetup({
  status,
  onSaved,
  onClose,
}: {
  status: KeyStatus | null;
  onSaved: (status: KeyStatus) => void;
  onClose?: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`${CORE_HTTP}/api/key`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ key }) : undefined,
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(body.detail ?? `The core returned ${resp.status}.`);
      setKey("");
      onSaved(body as KeyStatus);
    } catch (err) {
      setError(err instanceof TypeError ? "Could not reach the Jarvis core." : err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim() && !busy) void call("POST");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <div>
            <h2 className="font-display text-xl font-bold tracking-[0.2em] text-accent">OPENAI API KEY</h2>
            <p className="mt-2 text-sm text-dim">
              Jarvis runs on your own OpenAI account, so OpenAI bills you directly for what you use.
            </p>
          </div>

          <ol className="list-decimal space-y-1 pl-5 text-sm text-text">
            <li>
              Open{" "}
              <a href={KEYS_PAGE} target="_blank" rel="noreferrer" className="text-accent underline">
                platform.openai.com/api-keys
              </a>{" "}
              and sign in.
            </li>
            <li>Add a payment method under Billing if you haven't yet.</li>
            <li>Create a new secret key, copy it and paste it below.</li>
          </ol>

          {status?.key_set && (
            <div className="font-mono text-xs text-dim">
              Current key: {status.key_hint}
              {status.key_from_env && " (from .env, which takes priority)"}
            </div>
          )}

          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-..."
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent"
          />

          <p className="text-xs text-dim">
            The key is checked with OpenAI, then stored encrypted on this computer for your Windows account only.
          </p>

          {error && <div className="text-sm text-danger">{error}</div>}

          <div className="flex items-center justify-between gap-3">
            {status?.key_set && !status.key_from_env ? (
              <button type="button" disabled={busy} onClick={() => void call("DELETE")} className="text-xs text-dim hover:text-danger">
                Remove key
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-3">
              {onClose && (
                <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-dim hover:text-text">
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={busy || !key.trim()}
                className="border border-accent px-4 py-2 font-display text-sm font-semibold tracking-widest text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                {busy ? "CHECKING…" : "SAVE KEY"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
