// src/pages/Username.tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type ProfileRow = {
  id: string;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
  favorite_team: string | null;
  social_url: string | null;
};

export default function Username() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [userId, setUserId] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [favoriteTeam, setFavoriteTeam] = useState("");
  const [socialUrl, setSocialUrl] = useState("");

  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      setSuccess(null);

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        console.error("[Username] getSession error:", sessionError);
      }

      const user = session?.user ?? null;

      if (!user) {
        if (!mounted) return;
        setNeedsLogin(true);
        setLoading(false);
        return;
      }

      setUserId(user.id);

      const { data, error: profileError } = await supabase
        .from("profiles")
        .select("id, username, avatar_url, bio, favorite_team, social_url")
        .eq("id", user.id)
        .maybeSingle();

      if (!mounted) return;

      if (profileError) {
        console.error("[Username] profile load error:", profileError);
        setError("Failed to load profile.");
      }

      const row = data as ProfileRow | null;

      setUsername(row?.username ?? "");
      setAvatarUrl(row?.avatar_url ?? "");
      setBio(row?.bio ?? "");
      setFavoriteTeam(row?.favorite_team ?? "");
      setSocialUrl(row?.social_url ?? "");

      setLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    setSaving(true);
    setError(null);
    setSuccess(null);

    const trimmedUsername = username.trim() || null;
    const trimmedAvatar = avatarUrl.trim() || null;
    const trimmedBio = bio.trim() || null;
    const trimmedFavoriteTeam = favoriteTeam.trim() || null;
    const trimmedSocialUrl = socialUrl.trim() || null;

    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert(
        {
          id: userId,
          username: trimmedUsername,
          avatar_url: trimmedAvatar,
          bio: trimmedBio,
          favorite_team: trimmedFavoriteTeam,
          social_url: trimmedSocialUrl,
        },
        { onConflict: "id" }
      );

    setSaving(false);

    if (upsertError) {
      console.error("[Username] profile upsert error:", upsertError);
      setError("Failed to save profile. Please try again.");
      return;
    }

    setSuccess("Profile updated.");
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading profile...
        </div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Edit profile</p>
          <p>You must be logged in to edit your profile.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 text-slate-200">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400">
          Edit profile
        </h1>
        <button
          onClick={() => navigate(-1)}
          className="text-xs text-slate-400 hover:text-slate-100"
        >
          Back
        </button>
      </div>

      <p className="text-xs text-slate-400 mb-6">
        Update how you appear on the leaderboard and your public profile. Only
        summary stats are public; your individual picks stay private.
      </p>

      <form
        onSubmit={handleSave}
        className="space-y-6 bg-slate-900/70 border border-slate-700 rounded-xl p-5"
      >
        {error && (
          <div className="text-xs text-red-300 bg-red-900/30 border border-red-500/60 rounded px-3 py-2">
            {error}
          </div>
        )}
        {success && (
          <div className="text-xs text-emerald-300 bg-emerald-900/30 border border-emerald-500/60 rounded px-3 py-2">
            {success}
          </div>
        )}

        {/* Username */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold tracking-wide uppercase text-slate-300">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={32}
            className="w-full rounded-md bg-slate-950/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-yellow-400"
            placeholder="Example: SundaySharp"
          />
          <p className="text-[11px] text-slate-500">
            Shown on leaderboard and your public profile.
          </p>
        </div>

        {/* Avatar URL (optional) */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold tracking-wide uppercase text-slate-300">
            Avatar URL (optional)
          </label>
          <input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            className="w-full rounded-md bg-slate-950/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-yellow-400"
            placeholder="https://example.com/avatar.png"
          />
          <p className="text-[11px] text-slate-500">
            If provided, this image will show next to your name.
          </p>
        </div>

        {/* Favorite team */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold tracking-wide uppercase text-slate-300">
            Favorite team (optional)
          </label>
          <input
            type="text"
            value={favoriteTeam}
            onChange={(e) => setFavoriteTeam(e.target.value)}
            maxLength={64}
            className="w-full rounded-md bg-slate-950/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-yellow-400"
            placeholder="Example: Houston Texans"
          />
        </div>

        {/* Bio */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold tracking-wide uppercase text-slate-300">
            Bio (optional)
          </label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={4}
            maxLength={280}
            className="w-full rounded-md bg-slate-950/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-yellow-400 resize-none"
            placeholder="Tell people a little about your betting style or fandom."
          />
          <p className="text-[11px] text-slate-500">
            Shown on your public profile. Max 280 characters.
          </p>
        </div>

        {/* Social / external link */}
        <div className="space-y-1">
          <label className="block text-xs font-semibold tracking-wide uppercase text-slate-300">
            Profile link (optional)
          </label>
          <input
            type="url"
            value={socialUrl}
            onChange={(e) => setSocialUrl(e.target.value)}
            className="w-full rounded-md bg-slate-950/70 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-yellow-400"
            placeholder="https://twitter.com/yourhandle"
          />
          <p className="text-[11px] text-slate-500">
            If set, a button will appear on your public profile.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-3 py-1.5 rounded-md border border-slate-600 text-xs text-slate-200 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 rounded-md bg-yellow-400 text-xs font-semibold text-slate-900 hover:bg-yellow-300 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save profile"}
          </button>
        </div>
      </form>
    </div>
  );
}