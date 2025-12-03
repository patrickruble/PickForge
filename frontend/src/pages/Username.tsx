// src/pages/Username.tsx
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type LocationState = {
  userId?: string;
  email?: string;
};

export default function Username() {
  const nav = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as LocationState;

  const userId = state.userId ?? null;
  const email = state.email ?? null;

  const [newUsername, setNewUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------- SAVE HANDLER ----------------
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    if (!userId) {
      setError("You must be logged in to set a username.");
      return;
    }

    const trimmed = newUsername.trim();

    if (!trimmed) {
      setError("Please enter a username.");
      return;
    }
    if (trimmed.length < 3) {
      setError("Username must be at least 3 characters.");
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      setError("Only letters, numbers, and underscores are allowed.");
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    console.log("[Username] upserting profile", { userId, trimmed });

    // Fire-and-forget, no .catch (TS doesn't like it on PromiseLike)
    void supabase
      .from("profiles")
      .upsert(
        { id: userId, username: trimmed },
        { onConflict: "id" }
      )
      .then(
        ({ error }) => {
          if (error) {
            console.error("[Username] upsert error:", error);
            // we only show this if user is still on the page
            setError(error.message || "Failed to save username.");
          } else {
            console.log("[Username] upsert success");
          }
        },
        (err: unknown) => {
          console.error("[Username] upsert rejected:", err);
          const msg =
            err instanceof Error
              ? err.message
              : "Failed to save username (network error).";
          setError(msg);
        }
      );

    // Immediately update UI optimistically
    setSaving(false);
    setNewUsername("");
    setMessage("Username saved!");

    // brief pause so you see the message, then go home
    setTimeout(() => {
      nav("/"); // go to home / weekly picks, not /login
    }, 600);
  }

  // ---------------- MISSING USER INFO ----------------
  if (!userId) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="p-6 w-full max-w-md bg-slate-900/60 rounded-2xl">
          <h1 className="text-2xl font-bold text-yellow-400 mb-2">
            Set Username
          </h1>
          <p className="mb-4">
            Missing user info. Please go to the login page first.
          </p>
          <button
            onClick={() => nav("/login")}
            className="px-4 py-2 rounded-xl bg-yellow-400 text-black font-semibold"
          >
            Go to login
          </button>
        </div>
      </div>
    );
  }

  // ---------------- MAIN UI ----------------
  return (
    <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
      <div className="p-6 w-full max-w-md bg-slate-900/60 rounded-2xl">
        <h1 className="text-2xl font-bold text-yellow-400 mb-1">
          Set Username
        </h1>
        {email && <p className="text-slate-300 mb-4">{email}</p>}

        <p className="text-slate-400 text-sm mb-3">
          Set your PickForge handle. You’ll see it on the login card and
          leaderboard.
        </p>

        <form onSubmit={handleSave} className="space-y-4 mt-2">
          <div>
            <label className="block text-sm mb-1">New username</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="w-full rounded-lg px-3 py-2 bg-slate-950/60 border border-slate-700 text-slate-100 outline-none focus:border-yellow-400"
              placeholder="ForgeMaster22"
            />
          </div>

          <button
            className="w-full bg-yellow-400 text-black font-semibold py-2 rounded-xl hover:bg-yellow-300 disabled:opacity-60"
            type="submit"
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Username"}
          </button>
        </form>

        {message && (
          <p className="text-emerald-300 text-sm mt-3">{message}</p>
        )}
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>
    </div>
  );
}