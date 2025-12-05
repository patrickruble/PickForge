// src/pages/Username.tsx
import { useEffect, useState } from "react";
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
  const [avatarUploading, setAvatarUploading] = useState(false);

  const [userId, setUserId] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [favoriteTeam, setFavoriteTeam] = useState("");
  const [socialUrl, setSocialUrl] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Load current user and profile row
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      setSuccessMessage(null);

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        console.error("[Username] getSession error:", sessionError);
      }

      const user = session?.user ?? null;

      if (!mounted) return;

      if (!user) {
        setUserId(null);
        setError("You must be logged in to edit your profile.");
        setLoading(false);
        return;
      }

      setUserId(user.id);

      const { data, error: profileError } = await supabase
        .from("profiles")
        .select(
          "id, username, avatar_url, bio, favorite_team, social_url"
        )
        .eq("id", user.id)
        .maybeSingle();

      if (!mounted) return;

      if (profileError) {
        console.error("[Username] profile load error:", profileError);
        setError("Failed to load your profile.");
        setLoading(false);
        return;
      }

      const row = data as ProfileRow | null;

      setUsername(row?.username ?? "");
      setAvatarUrl(row?.avatar_url ?? null);
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
    setSuccessMessage(null);

    const payload: Partial<ProfileRow> = {
      username: username.trim() || null,
      bio: bio.trim() || null,
      favorite_team: favoriteTeam.trim() || null,
      social_url: socialUrl.trim() || null,
    };

    const { error: updateError } = await supabase
      .from("profiles")
      .update(payload)
      .eq("id", userId);

    setSaving(false);

    if (updateError) {
      console.error("[Username] profile update error:", updateError);
      setError("Failed to save your profile. Please try again.");
      return;
    }

    setSuccessMessage("Profile saved.");
  }

  async function handleAvatarChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file || !userId) return;

    setAvatarUploading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const ext = file.name.split(".").pop() || "jpg";
      const filePath = `${userId}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) {
        console.error("[Username] avatar upload error:", uploadError);
        setError("Failed to upload avatar. Please try a different image.");
        setAvatarUploading(false);
        return;
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from("avatars").getPublicUrl(filePath);

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: publicUrl })
        .eq("id", userId);

      if (updateError) {
        console.error("[Username] avatar_url update error:", updateError);
        setError("Avatar uploaded, but failed to save profile.");
        setAvatarUploading(false);
        return;
      }

      setAvatarUrl(publicUrl);
      setSuccessMessage("Avatar updated.");
    } finally {
      setAvatarUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading profile editor...
        </div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Profile</p>
          <p>You must be logged in to edit your profile.</p>
        </div>
      </div>
    );
  }

  const displayHandle =
    username.trim().length > 0
      ? `@${username.trim()}`
      : "Set your username";

  const initial =
    username.trim().length > 0
      ? username.trim()[0]?.toUpperCase()
      : "U";

  return (
    <div className="max-w-xl mx-auto px-4 py-10 text-slate-200">
      <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400 mb-2">
        Edit Profile
      </h1>
      <p className="text-xs text-slate-400 mb-6">
        Set your public username, avatar, and profile details. Other players
        will see this on the leaderboard and profile pages.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-300 bg-red-900/30 border border-red-500/60 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="mb-4 text-sm text-emerald-300 bg-emerald-900/30 border border-emerald-500/60 px-3 py-2 rounded">
          {successMessage}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Avatar + handle */}
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-lg font-semibold text-slate-100 border border-slate-600">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="w-full h-full object-cover"
              />
            ) : (
              initial
            )}
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-slate-100">
              {displayHandle}
            </p>
            <label className="mt-1 inline-flex items-center text-[11px] text-slate-300 cursor-pointer">
              <span className="px-2 py-1 rounded-full border border-slate-600 bg-slate-900/70 hover:border-yellow-400 hover:text-yellow-300 transition">
                {avatarUploading ? "Uploading..." : "Change avatar"}
              </span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
                disabled={avatarUploading}
              />
            </label>
            <p className="text-[10px] text-slate-500 mt-1">
              Recommended: square image, under 2 MB.
            </p>
          </div>
        </div>

        {/* Username */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">
            Username
          </label>
          <input
            type="text"
            className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-yellow-400"
            placeholder="Example: SundaySharp"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={24}
          />
          <p className="text-[11px] text-slate-500 mt-1">
            This is how you will appear on the leaderboard and your public
            profile.
          </p>
        </div>

        {/* Favorite team */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">
            Favorite team
          </label>
          <input
            type="text"
            className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-yellow-400"
            placeholder="Texans, Chiefs, Eagles..."
            value={favoriteTeam}
            onChange={(e) => setFavoriteTeam(e.target.value)}
            maxLength={50}
          />
        </div>

        {/* Bio */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">
            Bio
          </label>
          <textarea
            className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-yellow-400 min-h-[80px] resize-vertical"
            placeholder="Short note about your betting style, favorite team, or anything else."
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={300}
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Shown on your public profile.
          </p>
        </div>

        {/* Social link */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">
            Social or link (optional)
          </label>
          <input
            type="url"
            className="w-full rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-yellow-400"
            placeholder="https://"
            value={socialUrl}
            onChange={(e) => setSocialUrl(e.target.value)}
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Shown as a link on your profile. Make sure it is a full URL.
          </p>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-yellow-400 text-black text-sm font-semibold hover:bg-yellow-300 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save profile"}
          </button>
        </div>
      </form>
    </div>
  );
}