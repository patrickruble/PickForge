// src/pages/Username.tsx
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type LocationState = {
  userId?: string;
  email?: string;
};

type ProfileRow = {
  username: string | null;
  avatar_url: string | null;
};

export default function Username() {
  const nav = useNavigate();
  const location = useLocation();
  const state = (location.state || {}) as LocationState;

  const userId = state.userId ?? null;
  const email = state.email ?? null;

  const [newUsername, setNewUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load current profile (username + avatar)
  useEffect(() => {
    if (!userId) return;

    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("username, avatar_url")
        .eq("id", userId)
        .maybeSingle();

      if (error) {
        console.error("[Username] load profile error:", error);
        return;
      }

      const row = data as ProfileRow | null;
      if (row?.username) setNewUsername(row.username);
      if (row?.avatar_url) setAvatarUrl(row.avatar_url);
    })();
  }, [userId]);

  // ---------------- SAVE USERNAME ----------------
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

    const { error } = await supabase
      .from("profiles")
      .update({ username: trimmed })
      .eq("id", userId);

    setSaving(false);

    if (error) {
      console.error("[Username] save username error:", error);
      setError(error.message);
      return;
    }

    setMessage("Username saved!");
  }

  // ---------------- AVATAR UPLOAD ----------------
  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    try {
      setError(null);
      setMessage(null);

      if (!userId) {
        setError("You must be logged in to upload an avatar.");
        return;
      }

      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.");
        return;
      }

      setUploading(true);

      const ext = file.name.split(".").pop() || "png";
      const filePath = `${userId}/avatar.${ext}`;

      // upload to avatars bucket (upsert-style)
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, {
          upsert: true,
        });

      if (uploadError) {
        console.error("[Username] avatar upload error:", uploadError);
        setError(uploadError.message);
        setUploading(false);
        return;
      }

      // get public URL
      const { data } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);

      const publicUrl = data.publicUrl;

      // save on profile
      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", userId);

      setUploading(false);

      if (updateError) {
        console.error("[Username] avatar profile update error:", updateError);
        setError(updateError.message);
        return;
      }

      setAvatarUrl(publicUrl);
      setMessage("Avatar updated!");
    } catch (err: any) {
      console.error("[Username] avatar change error:", err);
      setUploading(false);
      setError(err?.message ?? "Failed to upload avatar.");
    }
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
      <div className="p-6 w-full max-w-md bg-slate-900/60 rounded-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-yellow-400 mb-1">
            Profile
          </h1>
          {email && <p className="text-slate-300 mb-2">{email}</p>}
          <p className="text-slate-400 text-sm">
            Set your PickForge handle and avatar. You’ll see them on the login
            card and leaderboard.
          </p>
        </div>

        {/* Avatar section */}
        <div className="space-y-3 border border-slate-800 rounded-xl p-4 bg-slate-900/60">
          <p className="text-sm font-semibold text-slate-200">Avatar</p>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center overflow-hidden text-xl font-bold text-yellow-400 border border-slate-700">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                (newUsername || email || "?")[0]?.toUpperCase()
              )}
            </div>
            <label className="text-xs">
              <span className="inline-flex items-center px-3 py-1 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 cursor-pointer">
                {uploading ? "Uploading…" : "Choose image"}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
                disabled={uploading}
              />
            </label>
          </div>
          <p className="text-[0.7rem] text-slate-500">
            Recommended: square image, at least 128×128. JPG or PNG.
          </p>
        </div>

        {/* Username section */}
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Username</label>
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
          <p className="text-emerald-300 text-sm mt-1">{message}</p>
        )}
        {error && <p className="text-red-400 text-sm mt-1">{error}</p>}
      </div>
    </div>
  );
}