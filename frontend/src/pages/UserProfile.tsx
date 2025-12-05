// src/pages/UserProfile.tsx
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAllUserStats } from "../hooks/useAllUserStats";

type ProfileInfo = {
  id: string;
  username: string | null;
  avatar_url: string | null;
  created_at: string | null;
};

function formatStreak(type: "W" | "L" | null, len: number) {
  if (!type || len === 0) return "—";
  return `${type}${len}`;
}

export default function UserProfile() {
  const { userId } = useParams<{ userId: string }>();

  const {
    statsByUser,
    loading: statsLoading,
    error: statsError,
  } = useAllUserStats();

  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Pull this user's season stats from the shared map
  const stats = userId ? statsByUser[userId] : undefined;

  // Load profile info (username, avatar, joined date)
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function loadProfile() {
      setProfileLoading(true);
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, avatar_url, created_at")
        .eq("id", userId)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error("[UserProfile] profile load error:", error);
        setProfile(null);
      } else if (data) {
        setProfile(data as ProfileInfo);
      } else {
        setProfile(null);
      }
      setProfileLoading(false);
    }

    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const displayName =
    profile?.username && profile.username.trim().length > 0
      ? profile.username
      : profile
      ? `user_${profile.id.slice(0, 6)}`
      : userId
      ? `user_${userId.slice(0, 6)}`
      : "Player";

  const initial = (displayName[0] ?? "?").toUpperCase();

  const createdLabel =
    profile?.created_at != null
      ? new Date(profile.created_at).toLocaleDateString()
      : null;

  // ---------- LOADING / ERROR STATES ----------

  if (statsLoading || profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading player profile…
        </div>
      </div>
    );
  }

  if (statsError) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-red-500/60 text-center">
          <p className="mb-2 font-semibold text-red-400">Error</p>
          <p>{statsError}</p>
        </div>
      </div>
    );
  }

  if (!userId || !stats) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Player not found</p>
          <p>This user either does not exist or has no graded picks yet.</p>
          <div className="mt-3">
            <Link
              to="/leaderboard"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-700/80 text-slate-300 hover:text-slate-100 text-xs"
            >
              ← Back to leaderboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ---------- MAIN UI ----------

  const recordText = `${stats.wins}-${stats.losses}${
    stats.pushes ? `-${stats.pushes}` : ""
  }`;

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-lg font-semibold text-slate-100 border border-slate-600">
            {profile?.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={displayName}
                className="w-full h-full object-cover"
              />
            ) : (
              initial
            )}
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400">
              {displayName}
            </h1>
            <p className="text-xs text-slate-400">
              @{displayName.toLowerCase().replace(/\s+/g, "")}
            </p>
            {createdLabel && (
              <p className="text-[11px] text-slate-500 mt-1">
                Joined {createdLabel}
              </p>
            )}
          </div>
        </div>
        <div className="text-right text-[11px]">
          <Link
            to="/leaderboard"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 text-slate-300 hover:text-slate-100 text-xs"
          >
            ← Back to leaderboard
          </Link>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-8">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Total Picks
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.totalPicks}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Win Rate
          </p>
          <p className="text-2xl mt-1 font-bold">
            {stats.totalPicks === 0 ? "—" : `${stats.winRate.toFixed(1)}%`}
          </p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Record
          </p>
          <p className="text-2xl mt-1 font-bold">{recordText}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Current Streak
          </p>
          <p className="text-2xl mt-1 font-bold">
            {formatStreak(stats.currentStreakType, stats.currentStreakLen)}
          </p>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        These numbers are season-long NFL results based on all finished games,
        using the spread or moneyline you locked in at pick time.
      </p>
    </div>
  );
}