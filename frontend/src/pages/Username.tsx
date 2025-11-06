// src/pages/Username.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

const USERNAME_RE = /^[a-zA-Z0-9_\.]{3,20}$/; // letters, numbers, _ and . (3–20)

export default function Username() {
  const [uid, setUid] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const [next, setNext] = useState("");
  const [available, setAvailable] = useState<null | boolean>(null);
  const [checking, setChecking] = useState(false);

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Load session + current username
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const u = session?.user ?? null;
      setUid(u?.id ?? null);
      setEmail(u?.email ?? null);
      if (!u?.id) return;

      const { data, error } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", u.id)
        .maybeSingle();

      if (!error) setCurrent(data?.username ?? null);
    })();
  }, []);

  // Debounced availability check
  const candidate = useMemo(() => next.trim(), [next]);
  useEffect(() => {
    let cancel = false;
    setMsg(null);

    // Don’t check if empty or invalid format or unchanged
    if (!candidate || !USERNAME_RE.test(candidate) || candidate === current) {
      setAvailable(null);
      return;
    }

    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id")
          .eq("username", candidate)
          .limit(1);

        if (!cancel) {
          if (error) {
            setAvailable(null);
          } else {
            setAvailable((data?.length ?? 0) === 0);
          }
        }
      } finally {
        if (!cancel) setChecking(false);
      }
    }, 350); // debounce

    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [candidate, current]);

  if (!uid) {
    return (
      <div className="p-6 text-slate-300">
        <h1 className="text-2xl font-bold text-yellow-400 mb-2">Set Username</h1>
        <p>Please <a className="text-yellow-400 underline" href="/login">login</a> first.</p>
      </div>
    );
  }

  const formatError =
    candidate && !USERNAME_RE.test(candidate)
      ? "Use 3–20 chars: letters, numbers, dot, underscore."
      : null;

  const disableSave =
    saving ||
    !!formatError ||
    !candidate ||
    candidate === current ||
    available === false;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);

    const value = candidate;
    if (!value || formatError) return;

    setSaving(true);
    try {
      const { error } = await supabase.rpc("set_username", { new_username: value });
      if (error) throw error;

      setCurrent(value);
      setNext("");
      setAvailable(null);
      setMsg("Username saved!");
    } catch (err: any) {
      const m = String(err?.message || "");
      // Friendly message if unique/duplicate constraint trips
      if (/duplicate|unique/i.test(m)) {
        setMsg("That username is already taken.");
        setAvailable(false);
      } else {
        setMsg(m || "Failed to save username.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-md">
      <h1 className="text-2xl font-bold text-yellow-400 mb-1">Account</h1>
      <p className="text-slate-300 mb-4">{email}</p>

      <div className="mb-3 text-slate-300">
        Current username: <b>{current ?? "— none —"}</b>
      </div>

      <form onSubmit={save} className="space-y-3">
        <div>
          <input
            className="w-full rounded-xl bg-slate-800 p-3 text-white outline-none border border-slate-700 focus:border-yellow-400"
            placeholder="choose a unique username (e.g., Pattymelt)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="mt-1 text-xs">
            {formatError && <span className="text-red-400">{formatError}</span>}
            {!formatError && checking && <span className="text-slate-400">Checking availability…</span>}
            {!formatError && available === true && <span className="text-emerald-400">Available ✓</span>}
            {!formatError && available === false && <span className="text-red-400">Taken</span>}
          </div>
        </div>

        <button
          className={`bg-yellow-400 text-black font-semibold px-4 py-2 rounded-xl ${disableSave ? "opacity-70 pointer-events-none" : ""}`}
          type="submit"
          disabled={disableSave}
        >
          {saving ? "Saving…" : "Save Username"}
        </button>

        {msg && <p className="text-slate-300">{msg}</p>}
      </form>
    </div>
  );
}