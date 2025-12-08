// src/pages/Feed.tsx
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getNflWeekNumber } from "../hooks/useRemotePicks";

type FollowRow = {
  follower_id: string;
  following_id: string;
};

type LeagueMemberRow = {
  league_id: string;
  user_id: string;
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

type Scope = "everyone" | "following" | "leagues";
type WindowMode = "week" | "season";

const fmtSigned = (n: number | null | undefined) =>
  typeof n === "number" ? (n > 0 ? `+${n}` : `${n}`) : "—";

export default function Feed() {
  const [uid, setUid] = useState<string | null>(null);

  // Filters
  const [scope, setScope] = useState<Scope>("following");
  const [windowMode, setWindowMode] = useState<WindowMode>("week");

  // Data
  const [people, setPeople] = useState<BasicProfile[]>([]);
  const [picks, setPicks] = useState<FeedPickRow[]>([]);

  // Status
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

  // 2) Load feed based on scope + window
  useEffect(() => {
    if (!uid) {
      setLoading(false);
      setPeople([]);
      setPicks([]);
      return;
    }

    let cancelled = false;

    async function loadFeed() {
      setLoading(true);
      setError(null);

      try {
        const nowIso = new Date().toISOString();

        let userIds: string[] | null = null;
        let scopedProfiles: BasicProfile[] = [];

        // ----- A) Figure out which users we care about, per scope -----
        if (scope === "following") {
          // Who do I follow?
          const { data: followRows, error: followError } = await supabase
            .from("follows")
            .select("follower_id, following_id")
            .eq("follower_id", uid);

          if (followError) {
            console.error("[Feed] follows error:", followError);
            if (!cancelled)
              setError("Could not load who you follow for the feed.");
            return;
          }

          const rows = (followRows ?? []) as FollowRow[];
          userIds = Array.from(new Set(rows.map((r) => r.following_id)));

          if (!userIds.length) {
            if (!cancelled) {
              setPeople([]);
              setPicks([]);
            }
            return;
          }

          // Load their profiles
          const { data: profiles, error: profilesError } = await supabase
            .from("profiles")
            .select("id, username, avatar_url")
            .in("id", userIds);

          if (profilesError) {
            console.error("[Feed] profiles error:", profilesError);
          }

          scopedProfiles = (profiles ?? []) as BasicProfile[];
        } else if (scope === "leagues") {
          // Find leagues I'm in
          const { data: myLeagueRows, error: myLeagueError } = await supabase
            .from("league_members")
            .select("league_id")
            .eq("user_id", uid);

          if (myLeagueError) {
            console.error("[Feed] my leagues error:", myLeagueError);
            if (!cancelled)
              setError("Could not load your leagues for the feed.");
            return;
          }

          const leagueIds = Array.from(
            new Set((myLeagueRows ?? []).map((r: any) => r.league_id as string))
          );

          if (!leagueIds.length) {
            if (!cancelled) {
              setPeople([]);
              setPicks([]);
            }
            return;
          }

          // Everyone in those leagues
          const { data: leagueMemberRows, error: leagueMembersError } =
            await supabase
              .from("league_members")
              .select("league_id, user_id")
              .in("league_id", leagueIds);

          if (leagueMembersError) {
            console.error(
              "[Feed] league members error:",
              leagueMembersError
            );
            if (!cancelled)
              setError("Could not load league members for the feed.");
            return;
          }

          const lmRows = (leagueMemberRows ?? []) as LeagueMemberRow[];
          userIds = Array.from(
            new Set(lmRows.map((r) => r.user_id).filter(Boolean))
          );

          if (!userIds.length) {
            if (!cancelled) {
              setPeople([]);
              setPicks([]);
            }
            return;
          }

          // Load profiles for league-mates
          const { data: profiles, error: profilesError } = await supabase
            .from("profiles")
            .select("id, username, avatar_url")
            .in("id", userIds);

          if (profilesError) {
            console.error("[Feed] league profiles error:", profilesError);
          }

          scopedProfiles = (profiles ?? []) as BasicProfile[];
        } else {
          // scope === "everyone"
          // userIds stays null; we'll fetch profiles based on picks later.
          userIds = null;
          scopedProfiles = [];
        }

        // ----- B) Load picks for this scope + window -----
        let query = supabase
          .from("picks")
          .select(
            "user_id, game_id, side, league, week, commence_at, picked_price_type, picked_price, picked_snapshot"
          )
          .eq("league", "nfl")
          .lte("commence_at", nowIso) // only games that have started
          .order("commence_at", { ascending: false });

        if (windowMode === "week") {
          query = query.eq("week", weekNum);
        }

        if (userIds && userIds.length) {
          query = query.in("user_id", userIds);
        }

        const { data: picksData, error: picksError } = await query;

        if (picksError) {
          console.error("[Feed] picks error:", picksError);
          if (!cancelled)
            setError("Could not load picks for the current filters.");
          return;
        }

        const pickedRows = (picksData ?? []) as FeedPickRow[];

        // For "everyone" scope, we still need profiles, but based on who appears in picks.
        if (scope === "everyone" && pickedRows.length) {
          const distinctUserIds = Array.from(
            new Set(pickedRows.map((p) => p.user_id))
          );
          const { data: profiles, error: profilesError } = await supabase
            .from("profiles")
            .select("id, username, avatar_url")
            .in("id", distinctUserIds);

          if (profilesError) {
            console.error("[Feed] everyone profiles error:", profilesError);
          }

          scopedProfiles = (profiles ?? []) as BasicProfile[];
        }

        if (!cancelled) {
          setPeople(scopedProfiles);
          setPicks(pickedRows);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadFeed();

    return () => {
      cancelled = true;
    };
  }, [uid, weekNum, scope, windowMode]);

  // Helper: map user id -> profile
  const profileById = useMemo(() => {
    const map = new Map<string, BasicProfile>();
    for (const p of people) {
      map.set(p.id, p);
    }
    return map;
  }, [people]);

  const scopeLabel = (() => {
    if (scope === "following") return "Following";
    if (scope === "leagues") return "My Leagues";
    return "Everyone";
  })();

  const windowLabel = windowMode === "week" ? `Week ${weekNum}` : "All Season";

  // ---------- UI STATES ----------

  if (!uid) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Pick Feed
        </h1>
        <p className="text-sm text-slate-400">
          Sign in to see picks from everyone, people you follow, and your
          private leagues.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <header className="mb-4 sm:mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
              Pick Feed — {windowLabel}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Live pick stream ({scopeLabel}). Picks only appear after kickoff.
            </p>
          </div>
          <FeedFilters
            scope={scope}
            setScope={setScope}
            windowMode={windowMode}
            setWindowMode={setWindowMode}
          />
        </header>

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
        <header className="mb-3 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
              Pick Feed — {windowLabel}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Live pick stream ({scopeLabel}).
            </p>
          </div>
          <FeedFilters
            scope={scope}
            setScope={setScope}
            windowMode={windowMode}
            setWindowMode={setWindowMode}
          />
        </header>
        <p className="text-sm text-rose-400">{error}</p>
      </div>
    );
  }

  if (!picks.length) {
    const emptyTextByScope: Record<Scope, string> = {
      following:
        "None of the people you follow have graded picks for this window yet.",
      leagues:
        "No league-mates have graded picks for this window yet, or you are not in any leagues.",
      everyone:
        "No graded picks match this window. Try switching to This Week or Following.",
    };

    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <header className="mb-3 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
              Pick Feed — {windowLabel}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Live pick stream ({scopeLabel}). Picks only appear after kickoff.
            </p>
          </div>
          <FeedFilters
            scope={scope}
            setScope={setScope}
            windowMode={windowMode}
            setWindowMode={setWindowMode}
          />
        </header>

        <p className="text-sm text-slate-400 mb-2">
          {emptyTextByScope[scope]}
        </p>

        {scope === "following" && (
          <p className="text-sm text-slate-400">
            Head to the{" "}
            <Link to="/leaderboard" className="text-yellow-400 underline">
              leaderboard
            </Link>{" "}
            to find players and follow them.
          </p>
        )}

        {scope === "leagues" && (
          <p className="text-sm text-slate-400">
            You can create or join private leagues on the{" "}
            <Link to="/leagues" className="text-yellow-400 underline">
              Leagues
            </Link>{" "}
            page.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <header className="mb-4 sm:mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            Pick Feed — {windowLabel}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Live pick stream ({scopeLabel}). Picks only appear after kickoff.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <FeedFilters
            scope={scope}
            setScope={setScope}
            windowMode={windowMode}
            setWindowMode={setWindowMode}
          />
          <div className="text-[11px] sm:text-xs text-slate-400">
            <span className="font-semibold text-slate-100">
              {picks.length}
            </span>{" "}
            picks shown.
          </div>
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
                      Game kicked off {when}
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
                    NFL • Week {p.week} • {away} @ {home}
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

// Small subcomponent for the filter pills
type FeedFiltersProps = {
  scope: Scope;
  setScope: (s: Scope) => void;
  windowMode: WindowMode;
  setWindowMode: (w: WindowMode) => void;
};

function FeedFilters({
  scope,
  setScope,
  windowMode,
  setWindowMode,
}: FeedFiltersProps) {
  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <div className="inline-flex rounded-full bg-slate-900/80 border border-slate-700 p-1 text-[11px] sm:text-xs">
        {[
          { key: "everyone", label: "Everyone" },
          { key: "following", label: "Following" },
          { key: "leagues", label: "My Leagues" },
        ].map((opt) => {
          const active = scope === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => setScope(opt.key as Scope)}
              className={
                "px-2.5 py-1 rounded-full transition " +
                (active
                  ? "bg-yellow-400 text-slate-900 font-semibold"
                  : "text-slate-300 hover:text-slate-100")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div className="inline-flex rounded-full bg-slate-900/80 border border-slate-700 p-1 text-[11px] sm:text-xs">
        {[
          { key: "week", label: "This Week" },
          { key: "season", label: "All Season" },
        ].map((opt) => {
          const active = windowMode === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => setWindowMode(opt.key as WindowMode)}
              className={
                "px-2.5 py-1 rounded-full transition " +
                (active
                  ? "bg-slate-100 text-slate-900 font-semibold"
                  : "text-slate-300 hover:text-slate-100")
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}