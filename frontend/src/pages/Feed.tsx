// src/pages/Feed.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";   // 👈 add this
import { supabase } from "../lib/supabase";
import { getNflWeekNumber } from "../hooks/useRemotePicks";

type FollowRow = {
  follower_id: string;
  following_id: string;
};

type PickSnapshot = {
  home?: string;
  away?: string;
  spreadHome?: number | null;
  spreadAway?: number | null;
  mlHome?: number | null;
  mlAway?: number | null;
};

type FeedPickRow = {
  user_id: string;
  game_id: string;
  side: "home" | "away";
  league: "nfl";
  week: number;
  commence_at: string;
  picked_price_type?: "ml" | "spread" | null;
  picked_price?: number | null;
  picked_snapshot?: PickSnapshot | null;
};

type BasicProfile = {
  id: string;
  username: string | null;
  avatar_url: string | null;
};

const fmtSigned = (n: number | null | undefined) =>
  typeof n === "number" ? (n > 0 ? `+${n}` : `${n}`) : "—";

export default function Feed() {
  const [uid, setUid] = useState<string | null>(null);
  const [following, setFollowing] = useState<BasicProfile[]>([]);
  const [picks, setPicks] = useState<FeedPickRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const weekNum = getNflWeekNumber(new Date());

  // 1) Get current authed user
  useEffect(() => {
    let cancelled = false;

    async function loadAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (cancelled) return;
      const user = session?.user ?? null;
      setUid(user?.id ?? null);
    }

    loadAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Load following list + their picks (only games that have started)
  useEffect(() => {
    if (!uid) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function loadFeed() {
      setLoading(true);
      setError(null);

      try {
        // --- A) Who do I follow? ---
        const { data: followRows, error: followError } = await supabase
          .from("follows")
          .select("follower_id, following_id")
          .eq("follower_id", uid);

        if (followError) {
          console.error("[Feed] follows error:", followError);
          if (!cancelled) setError("Could not load who you follow.");
          return;
        }

        const rows = (followRows ?? []) as FollowRow[];
        const followingIds = Array.from(
          new Set(rows.map((r) => r.following_id))
        );

        if (!followingIds.length) {
          if (!cancelled) {
            setFollowing([]);
            setPicks([]);
          }
          return;
        }

        // --- B) Load basic profiles for those users ---
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("id, username, avatar_url")
          .in("id", followingIds);

        if (profilesError) {
          console.error("[Feed] profiles error:", profilesError);
        }

        const followingProfiles = (profiles ?? []) as BasicProfile[];

        if (!cancelled) {
          setFollowing(followingProfiles);
        }

        // --- C) Load their picks for this week, ONLY after game starts ---
        const nowIso = new Date().toISOString();

        const { data: picksData, error: picksError } = await supabase
          .from("picks")
          .select(
            "user_id, game_id, side, league, week, commence_at, picked_price_type, picked_price, picked_snapshot"
          )
          .in("user_id", followingIds)
          .eq("league", "nfl")
          .eq("week", weekNum)
          .lte("commence_at", nowIso) // only games that have started
          .order("commence_at", { ascending: false });

        if (picksError) {
          console.error("[Feed] picks error:", picksError);
          if (!cancelled) setError("Could not load followers’ picks.");
          return;
        }

        if (!cancelled) {
          setPicks((picksData ?? []) as FeedPickRow[]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadFeed();

    return () => {
      cancelled = true;
    };
  }, [uid, weekNum]);

  // Helper: map user id -> profile
  const profileById = new Map<string, BasicProfile>();
  for (const p of following) {
    profileById.set(p.id, p);
  }

  // ---------- UI STATES ----------

  if (!uid) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Friends’ Picks
        </h1>
        <p className="text-sm text-slate-400">
          Sign in to see picks from people you follow.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Friends’ Picks — Week {weekNum}
        </h1>
        <p className="text-sm text-slate-400 mb-4">
          Loading picks from people you follow…
        </p>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded-xl bg-slate-900/80 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Friends’ Picks — Week {weekNum}
        </h1>
        <p className="text-sm text-rose-400">{error}</p>
      </div>
    );
  }

  if (!following.length) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Friends’ Picks — Week {weekNum}
        </h1>
        <p className="text-sm text-slate-400 mb-2">
          You’re not following anyone yet.
        </p>
        <p className="text-sm text-slate-400">
          Head to the{" "}
          <Link to="/leaderboard" className="text-yellow-400 underline">
            leaderboard
          </Link>{" "}
          and start following players you want to track.
        </p>
      </div>
    );
  }

  if (!picks.length) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Friends’ Picks — Week {weekNum}
        </h1>
        <p className="text-sm text-slate-400">
          None of the people you follow have started games yet this week, or
          their games haven’t kicked off. Picks appear here after kickoff only.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <header className="mb-4 sm:mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            Friends’ Picks — Week {weekNum}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Picks from people you follow. Only visible after the game starts.
          </p>
        </div>
        <div className="text-[11px] sm:text-xs text-slate-400">
          <span className="font-semibold text-slate-100">{picks.length}</span>{" "}
          picks shown.
        </div>
      </header>

      <ul className="space-y-3">
        {picks.map((p) => {
          const prof = profileById.get(p.user_id);
          const snap = (p.picked_snapshot ?? {}) as PickSnapshot;
          const home = snap.home ?? "HOME";
          const away = snap.away ?? "AWAY";
          const when = new Date(p.commence_at).toLocaleString();

          const pickedTeam = p.side === "home" ? home : away;

          let lineLabel = "";
          if (p.picked_price_type === "spread") {
            lineLabel = `Spread ${fmtSigned(p.picked_price ?? null)}`;
          } else if (p.picked_price_type === "ml") {
            lineLabel = `ML ${fmtSigned(p.picked_price ?? null)}`;
          } else {
            lineLabel = "(line unavailable)";
          }

          const handleUrlSlug =
            prof?.username && prof.username.trim().length > 0
              ? prof.username.trim()
              : prof?.id ?? p.user_id;

          return (
            <li
              key={`${p.user_id}-${p.game_id}-${p.side}`}
              className="rounded-2xl p-3 sm:p-4 bg-slate-950/80 border border-slate-800 shadow-sm shadow-black/30"
            >
              <div className="flex items-start justify-between gap-3">
                {/* Left: user avatar + name */}
                <Link
                  to={`/u/${handleUrlSlug}`}
                  className="flex items-center gap-2 sm:gap-3"
                >
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-100 border border-slate-600">
                    {prof?.avatar_url ? (
                      <img
                        src={prof.avatar_url}
                        alt={prof.username ?? "User"}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      (prof?.username?.[0] ?? "U").toUpperCase()
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-100">
                      {prof?.username ?? `user_${p.user_id.slice(0, 6)}`}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      Game kicks off {when}
                    </span>
                  </div>
                </Link>

                {/* Right: pick details */}
                <div className="text-right text-[11px] sm:text-xs text-slate-300">
                  <div className="mb-0.5">
                    Picked{" "}
                    <span className="font-semibold text-yellow-300">
                      {pickedTeam}
                    </span>
                  </div>
                  <div className="text-slate-400">{lineLabel}</div>
                  <div className="text-slate-500 mt-1 text-[10px]">
                    {away} @ {home}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}