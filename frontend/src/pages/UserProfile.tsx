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

type BasicProfile = {
  id: string;
  username: string | null;
  avatar_url: string | null;
};

function formatStreak(type: "W" | "L" | null, len: number) {
  if (!type || len === 0) return "—";
  return `${type}${len}`;
}

// ---- Follows table config (matches your SQL) ----
const FOLLOW_TABLE = "follows";
const FOLLOWER_COL = "follower_id"; // who is following
const FOLLOWING_COL = "following_id"; // who they follow

// Small follow/unfollow pill component
function FollowButton({
  viewerId,
  profileId,
  onChange,
}: {
  viewerId: string;
  profileId: string;
  onChange: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);

  // Load follow state
  useEffect(() => {
    let mounted = true;

    async function loadFollow() {
      const { data, error } = await supabase
        .from(FOLLOW_TABLE)
        .select(FOLLOWER_COL)
        .eq(FOLLOWER_COL, viewerId)
        .eq(FOLLOWING_COL, profileId)
        .maybeSingle();

      if (!mounted) return;

      if (error) {
        console.error("[FollowButton] load error:", error);
        setIsFollowing(false);
      } else {
        setIsFollowing(!!data);
      }
    }

    loadFollow();
    return () => {
      mounted = false;
    };
  }, [viewerId, profileId]);

  async function toggleFollow() {
    if (loading || isFollowing === null) return;
    setLoading(true);

    try {
      if (!isFollowing) {
        // FOLLOW
        const { error } = await supabase.from(FOLLOW_TABLE).insert({
          [FOLLOWER_COL]: viewerId,
          [FOLLOWING_COL]: profileId,
        });
        if (error) {
          console.error("[FollowButton] follow error:", error);
        } else {
          setIsFollowing(true);
          onChange();
        }
      } else {
        // UNFOLLOW
        const { error } = await supabase
          .from(FOLLOW_TABLE)
          .delete()
          .eq(FOLLOWER_COL, viewerId)
          .eq(FOLLOWING_COL, profileId);

        if (error) {
          console.error("[FollowButton] unfollow error:", error);
        } else {
          setIsFollowing(false);
          onChange();
        }
      }
    } finally {
      setLoading(false);
    }
  }

  const base =
    "w-full inline-flex items-center justify-center px-2.5 py-1 rounded-full text-[11px] border transition";

  return (
    <button
      type="button"
      onClick={toggleFollow}
      disabled={loading || isFollowing === null}
      className={
        isFollowing
          ? base +
            " bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-300 disabled:opacity-60"
          : base +
            " bg-slate-900 text-slate-200 border-slate-600 hover:border-yellow-400 hover:text-yellow-300 disabled:opacity-60"
      }
    >
      {loading || isFollowing === null ? "…" : isFollowing ? "Following" : "Follow"}
    </button>
  );
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

  const [followers, setFollowers] = useState<BasicProfile[]>([]);
  const [following, setFollowing] = useState<BasicProfile[]>([]);
  const [followLoading, setFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followVersion, setFollowVersion] = useState(0); // bump to reload

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

  // Load profile info (lookup by id OR username)
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    async function loadProfile() {
      setProfileLoading(true);
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, username, avatar_url, created_at, bio, favorite_team, social_url"
        )
        .or(`id.eq.${slug},username.eq.${slug}`)
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

  // Load followers + following for this profile (using follower_id / following_id schema)
  useEffect(() => {
    const userId = profile?.id;
    if (!userId) return;

    let cancelled = false;

    async function loadFollows() {
      setFollowLoading(true);
      setFollowError(null);

      try {
        // who follows me, and who I follow
        const [
          { data: followerRows, error: followerError },
          { data: followingRows, error: followingError },
        ] = await Promise.all([
          supabase
            .from(FOLLOW_TABLE)
            .select(FOLLOWER_COL)
            .eq(FOLLOWING_COL, userId),
          supabase
            .from(FOLLOW_TABLE)
            .select(FOLLOWING_COL)
            .eq(FOLLOWER_COL, userId),
        ]);

        if (cancelled) return;

        if (followerError || followingError) {
          console.error("[UserProfile] follow load error:", {
            followerError,
            followingError,
          });
          setFollowError("Failed to load following.");
          setFollowers([]);
          setFollowing([]);
          return;
        }

        const followerIds = Array.from(
          new Set(
            (followerRows ?? []).map((r: any) => r[FOLLOWER_COL] as string)
          )
        );
        const followingIds = Array.from(
          new Set(
            (followingRows ?? []).map((r: any) => r[FOLLOWING_COL] as string)
          )
        );

        let followerProfiles: BasicProfile[] = [];
        let followingProfiles: BasicProfile[] = [];

        if (followerIds.length > 0) {
          const { data, error } = await supabase
            .from("profiles")
            .select("id, username, avatar_url")
            .in("id", followerIds);

          if (!cancelled && !error && data) {
            followerProfiles = data as BasicProfile[];
          } else if (error) {
            console.error("[UserProfile] follower profiles error:", error);
          }
        }

        if (followingIds.length > 0) {
          const { data, error } = await supabase
            .from("profiles")
            .select("id, username, avatar_url")
            .in("id", followingIds);

          if (!cancelled && !error && data) {
            followingProfiles = data as BasicProfile[];
          } else if (error) {
            console.error("[UserProfile] following profiles error:", error);
          }
        }

        if (!cancelled) {
          setFollowers(followerProfiles);
          setFollowing(followingProfiles);
        }
      } finally {
        if (!cancelled) setFollowLoading(false);
      }
    }

    loadFollows();
    return () => {
      cancelled = true;
    };
  }, [profile?.id, followVersion]);

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
    currentUserId != null &&
    statsUserId != null &&
    currentUserId === statsUserId;

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

  const followerCount = followers.length;
  const followingCount = following.length;

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

  // Only treat "not found" as "no profile"
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
    stats && stats.totalPicks > 0 ? `${stats.winRate.toFixed(1)}%` : "0.0%";
  const recordText =
    stats && stats.totalPicks > 0
      ? `${stats.wins}-${stats.losses}${
          stats.pushes ? `-${stats.pushes}` : ""
        }`
      : "0-1"; // your default
  const streakLabel =
    stats && stats.totalPicks > 0
      ? formatStreak(stats.currentStreakType, stats.currentStreakLen)
      : "L1";

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
            <p className="text-[11px] text-slate-400 mt-1">
              <span className="font-semibold text-slate-100">
                {followerCount}
              </span>{" "}
              Followers{" "}
              <span className="mx-1 text-slate-600">•</span>
              <span className="font-semibold text-slate-100">
                {followingCount}
              </span>{" "}
              Following
            </p>
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

          {/* Follow pill – only when viewing someone else */}
          {profile &&
            currentUserId &&
            profile.id !== currentUserId && (
              <FollowButton
                viewerId={currentUserId}
                profileId={profile.id}
                onChange={() => setFollowVersion((v) => v + 1)}
              />
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

      {/* Following list */}
      <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-100">Following</h2>
          {followLoading && (
            <span className="text-[11px] text-slate-500">Loading…</span>
          )}
        </div>

        {followError && (
          <p className="text-xs text-rose-400 mb-1">{followError}</p>
        )}

        {!followLoading && !following.length && !followError && (
          <p className="text-xs text-slate-500">Not following anyone yet.</p>
        )}

        {!!following.length && (
          <ul className="flex flex-wrap gap-2 mt-1">
            {following.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/u/${
                    p.username && p.username.trim().length > 0
                      ? p.username
                      : p.id
                  }`}
                  className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-[11px] hover:border-yellow-400 hover:text-yellow-300"
                >
                  <div className="w-6 h-6 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-[10px] font-semibold">
                    {p.avatar_url ? (
                      <img
                        src={p.avatar_url}
                        alt={p.username ?? p.id}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      (p.username?.[0] ?? "U").toUpperCase()
                    )}
                  </div>
                  <span>{p.username ?? `user_${p.id.slice(0, 6)}`}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-slate-400">
        Public profile shows season summary only. Individual picks are private.
      </p>
    </div>
  );
}