// src/pages/UserProfile.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAllUserStats } from "../hooks/useAllUserStats";

type ProfileInfo = {
  id: string;
  username: string | null;
  avatar_url: string | null;
  created_at: string | null;
  bio: string | null;
  favorite_team: string | null;
  social_url: string | null;
};

function formatStreak(type: "W" | "L" | null, len: number) {
  if (!type || len === 0) return "—";
  return `${type}${len}`;
}

export default function UserProfile() {
  // slug can be username OR raw user id
  const { slug } = useParams<{ slug: string }>();

  const {
    statsByUser,
    loading: statsLoading,
    error: statsError,
  } = useAllUserStats();

  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Logged-in user, so we know if this is "my" profile
  useEffect(() => {
    let cancelled = false;

    async function loadAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (cancelled) return;
      const user = session?.user ?? null;
      setCurrentUserId(user?.id ?? null);
    }

    loadAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load profile info: first by id, then by username
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    async function loadProfile() {
      setProfileLoading(true);

      try {
        // 1) Try lookup by ID (UUID)
        let finalProfile: ProfileInfo | null = null;

        const { data: byId, error: idError } = await supabase
          .from("profiles")
          .select(
            "id, username, avatar_url, created_at, bio, favorite_team, social_url"
          )
          .eq("id", slug)
          .maybeSingle();

        if (idError) {
          console.error("[UserProfile] profile load error by id:", idError);
        }

        if (byId) {
          finalProfile = byId as ProfileInfo;
        } else {
          // 2) Fallback: lookup by username
          const { data: byUsername, error: usernameError } = await supabase
            .from("profiles")
            .select(
              "id, username, avatar_url, created_at, bio, favorite_team, social_url"
            )
            .eq("username", slug) // change to .ilike(slug) if you want case-insensitive
            .maybeSingle();

          if (usernameError) {
            console.error(
              "[UserProfile] profile load error by username:",
              usernameError
            );
          }

          if (byUsername) {
            finalProfile = byUsername as ProfileInfo;
          }
        }

        if (cancelled) return;
        setProfile(finalProfile);
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    }

    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const statsUserId = profile?.id ?? null;
  const stats = statsUserId ? statsByUser[statsUserId] : undefined;

  const displayName =
    profile?.username && profile.username.trim().length > 0
      ? profile.username
      : profile
      ? `user_${profile.id.slice(0, 6)}`
      : slug
      ? slug
      : "Player";

  const initial = (displayName[0] ?? "?").toUpperCase();

  const createdLabel =
    profile?.created_at != null
      ? new Date(profile.created_at).toLocaleDateString()
      : null;

  // Season rank for this user (optional)
  const { seasonRank, totalPlayers } = useMemo(() => {
    if (!statsUserId) {
      return { seasonRank: null as number | null, totalPlayers: 0 };
    }

    const entries = Object.entries(statsByUser).filter(
      ([, s]) => s.totalPicks > 0
    );

    entries.sort((a, b) => {
      const sa = a[1];
      const sb = b[1];
      if (sb.winRate !== sa.winRate) return sb.winRate - sa.winRate;
      return sb.wins - sa.wins;
    });

    const index = entries.findIndex(([id]) => id === statsUserId);
    return {
      seasonRank: index >= 0 ? index + 1 : null,
      totalPlayers: entries.length,
    };
  }, [statsUserId, statsByUser]);

  // Simple badge system
  const badges: string[] = useMemo(() => {
    if (!stats) return ["Rookie Season"];

    const list: string[] = [];

    if (stats.totalPicks >= 75) {
      list.push("Volume Player");
    } else if (stats.totalPicks >= 25) {
      list.push("Getting Reps");
    }

    if (stats.totalPicks >= 30 && stats.winRate >= 55) {
      list.push("Sharp Shooter");
    }

    if (stats.currentStreakType === "W" && stats.currentStreakLen >= 3) {
      list.push("On a Heater");
    } else if (stats.currentStreakType === "L" && stats.currentStreakLen >= 3) {
      list.push("Ice Cold");
    }

    if (!list.length) {
      list.push("Rookie Season");
    }

    return list;
  }, [stats]);

  const isOwnProfile =
    currentUserId != null && statsUserId != null && currentUserId === statsUserId;

  // canonical slug for this profile (prefer username, fallback to id / slug)
  const canonicalSlug =
    profile?.username && profile.username.trim().length > 0
      ? profile.username.trim()
      : profile?.id ?? slug ?? "";

  const profileUrl = useMemo(() => {
    if (typeof window === "undefined" || !canonicalSlug) return "";
    return `${window.location.origin}/u/${canonicalSlug}`;
  }, [canonicalSlug]);

  async function handleCopyProfile() {
    if (!profileUrl) return;
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("[UserProfile] clipboard error:", err);
    }
  }

  // ---------- LOADING / ERROR STATES ----------

  if (statsLoading || profileLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading player profile...
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

  if (!slug || !profile) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Player not found</p>
          <p>This user either does not exist or has not set up a profile yet.</p>
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

  const totalPicks = stats?.totalPicks ?? 0;
  const winRateLabel =
    stats && stats.totalPicks > 0 ? `${stats.winRate.toFixed(1)}%` : "—";
  const recordText =
    stats && stats.totalPicks > 0
      ? `${stats.wins}-${stats.losses}${
          stats.pushes ? `-${stats.pushes}` : ""
        }`
      : "0-0";
  const streakLabel =
    stats && stats.totalPicks > 0
      ? formatStreak(stats.currentStreakType, stats.currentStreakLen)
      : "—";

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-lg font-semibold text-slate-100 border border-slate-600">
            {profile.avatar_url ? (
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
            {profile.favorite_team && (
              <p className="text-[11px] text-slate-400 mt-1">
                Favorite team:{" "}
                <span className="text-slate-200">{profile.favorite_team}</span>
              </p>
            )}
          </div>
        </div>

        <div className="text-right text-[11px] space-y-2">
          {isOwnProfile && (
            <Link
              to="/username"
              className="inline-flex items-center justify-center px-3 py-1.5 rounded-full bg-yellow-400 text-slate-900 font-semibold hover:bg-yellow-300 text-xs"
            >
              Edit profile
            </Link>
          )}

          {profileUrl && (
            <button
              type="button"
              onClick={handleCopyProfile}
              className="block w-full inline-flex items-center justify-center px-2.5 py-1 rounded-full border border-slate-600 text-[11px] text-slate-200 hover:text-yellow-300 hover:border-yellow-400"
            >
              {copied ? "Copied profile link" : "Copy profile link"}
            </button>
          )}

          <div>
            <Link
              to="/leaderboard"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 text-slate-300 hover:text-slate-100 text-xs"
            >
              ← Back to leaderboard
            </Link>
          </div>

          {profile.social_url && (
            <div>
              <a
                href={profile.social_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-slate-600 text-[11px] text-slate-200 hover:text-yellow-300 hover:border-yellow-400"
              >
                External profile
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-8">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Total Picks
          </p>
          <p className="text-2xl mt-1 font-bold">{totalPicks}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Win Rate
          </p>
          <p className="text-2xl mt-1 font-bold">{winRateLabel}</p>
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
          <p className="text-2xl mt-1 font-bold">{streakLabel}</p>
        </div>
      </div>

      {/* About + Rank / Badges */}
      <div className="grid gap-6 md:grid-cols-[2fr,1.5fr] mb-8">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <h2 className="text-sm font-semibold text-slate-100 mb-2">About</h2>
          {profile.bio && profile.bio.trim().length > 0 ? (
            <p className="text-sm text-slate-300 whitespace-pre-line">
              {profile.bio}
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              This player has not added a bio yet.
            </p>
          )}
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <h2 className="text-sm font-semibold text-slate-100 mb-2">
            Season placement
          </h2>
          {seasonRank && totalPlayers > 0 ? (
            <p className="text-sm text-slate-300">
              Currently{" "}
              <span className="font-semibold text-yellow-400">
                #{seasonRank}
              </span>{" "}
              of {totalPlayers} players on the season leaderboard.
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Season rank will appear once this player has graded picks.
            </p>
          )}

          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
              Badges
            </p>
            <div className="flex flex-wrap gap-1.5">
              {badges.map((b) => (
                <span
                  key={b}
                  className="px-2 py-0.5 rounded-full border border-slate-700 text-[11px] text-slate-200 bg-slate-800/80"
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Public profile shows season summary only. Individual picks are private.
      </p>
    </div>
  );
}