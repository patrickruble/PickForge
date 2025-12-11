// src/pages/Feed.tsx
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getNflWeekNumber, currentNflWeekWindow } from "../hooks/useRemotePicks";

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

type FeedBetRow = {
  id: string;
  user_id: string;
  event_name: string;
  selection: string;
  odds_american: number | null;
  stake: number;
  result_amount: number;
  status: string;
  event_date: string | null;
  created_at: string;
};

type GameAggregate = {
  gameId: string;
  week: number;
  commence_at: string;
  home: string;
  away: string;
  total: number;
  homeCount: number;
  awayCount: number;
  homePct: number;
  awayPct: number;
  followersHome: BasicProfile[];
  followersAway: BasicProfile[];
};

type BasicProfile = {
  id: string;
  username: string | null;
  avatar_url: string | null;
};

type Scope = "everyone" | "following" | "leagues";

type WindowMode = "week" | "season";

type FeedItem =
  | { kind: "pick"; pick: FeedPickRow }
  | { kind: "bet"; bet: FeedBetRow };

const fmtSigned = (n: number | null | undefined) =>
  typeof n === "number" ? (n > 0 ? `+${n}` : `${n}`) : "—";

export default function Feed() {
  const [uid, setUid] = useState<string | null>(null);

  // Viewer unit size for displaying bets in "u" instead of dollars
  const [unitSize, setUnitSize] = useState<number | null>(null);

  // Which users I follow (for highlighting in game splits)
  const [followingIds, setFollowingIds] = useState<string[]>([]);

  // Filters
  const [scope, setScope] = useState<Scope>("following");
  const [windowMode, setWindowMode] = useState<WindowMode>("week");

  // Data
  const [people, setPeople] = useState<BasicProfile[]>([]);
  const [picks, setPicks] = useState<FeedPickRow[]>([]);
  const [bets, setBets] = useState<FeedBetRow[]>([]);

  // Status
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const weekNum = getNflWeekNumber(new Date());

  useEffect(() => {
    try {
      const raw = localStorage.getItem("pf_unit_size");
      if (!raw) return;
      const n = Number(raw);
      if (!Number.isNaN(n) && n > 0) {
        setUnitSize(n);
      }
    } catch {
      // ignore localStorage errors
    }
  }, []);

  // Load list of users I follow (used to highlight them in game splits)
  useEffect(() => {
    if (!uid) {
      setFollowingIds([]);
      return;
    }

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("follows")
        .select("follower_id, following_id")
        .eq("follower_id", uid);

      if (cancelled) return;

      if (error) {
        console.error("[Feed] follows-for-highlight error:", error);
        setFollowingIds([]);
        return;
      }

      const rows = (data ?? []) as FollowRow[];
      const ids = Array.from(new Set(rows.map((r) => r.following_id)));
      setFollowingIds(ids);
    })();

    return () => {
      cancelled = true;
    };
  }, [uid]);

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
      setBets([]);
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
        let mutualIds: string[] = [];

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

          // Which of these follow you back? Mutuals only.
          const { data: mutualRows, error: mutualError } = await supabase
            .from("follows")
            .select("follower_id, following_id")
            .in("follower_id", userIds)
            .eq("following_id", uid);

          if (mutualError) {
            console.error("[Feed] mutuals error:", mutualError);
          } else if (mutualRows) {
            mutualIds = Array.from(
              new Set((mutualRows as FollowRow[]).map((r) => r.follower_id))
            );
          }
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

        // C) Load bets for mutual followers (only in Following scope)
        let betsRows: FeedBetRow[] = [];
        if (scope === "following" && mutualIds.length) {
          let betsQuery = supabase
            .from("bets")
            .select(
              "id, user_id, event_name, selection, odds_american, stake, result_amount, status, event_date, created_at"
            )
            .in("user_id", mutualIds)
            .order("event_date", { ascending: false });

          if (windowMode === "week") {
            const { weekStart, weekEnd } = currentNflWeekWindow(new Date());
            betsQuery = betsQuery
              .gte("event_date", weekStart.toISOString())
              .lte("event_date", weekEnd.toISOString());
          }

          const { data: betsData, error: betsError } = await betsQuery;
          if (betsError) {
            console.error("[Feed] bets error:", betsError);
          } else {
            betsRows = (betsData ?? []) as FeedBetRow[];
          }
        }

        if (!cancelled) {
          setPeople(scopedProfiles);
          setPicks(pickedRows);
          setBets(betsRows);
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

  const games = useMemo<GameAggregate[]>(() => {
    if (!picks.length) return [];

    const followingSet = new Set(followingIds);
    const map = new Map<
      string,
      {
        gameId: string;
        week: number;
        commence_at: string;
        home: string;
        away: string;
        total: number;
        homeCount: number;
        awayCount: number;
        followersHomeIds: Set<string>;
        followersAwayIds: Set<string>;
      }
    >();

    for (const p of picks) {
      let g = map.get(p.game_id);
      if (!g) {
        const snap = (p.picked_snapshot ?? {}) as PickSnapshot;
        g = {
          gameId: p.game_id,
          week: p.week,
          commence_at: p.commence_at,
          home: snap.home ?? "HOME",
          away: snap.away ?? "AWAY",
          total: 0,
          homeCount: 0,
          awayCount: 0,
          followersHomeIds: new Set<string>(),
          followersAwayIds: new Set<string>(),
        };
        map.set(p.game_id, g);
      }

      g.total += 1;

      if (p.side === "home") {
        g.homeCount += 1;
        if (followingSet.has(p.user_id)) {
          g.followersHomeIds.add(p.user_id);
        }
      } else {
        g.awayCount += 1;
        if (followingSet.has(p.user_id)) {
          g.followersAwayIds.add(p.user_id);
        }
      }
    }

    const out: GameAggregate[] = [];

    for (const g of map.values()) {
      const homePct = g.total ? (g.homeCount / g.total) * 100 : 0;
      const awayPct = g.total ? (g.awayCount / g.total) * 100 : 0;

      const followersHome = Array.from(g.followersHomeIds)
        .map((id) => profileById.get(id))
        .filter(Boolean) as BasicProfile[];

      const followersAway = Array.from(g.followersAwayIds)
        .map((id) => profileById.get(id))
        .filter(Boolean) as BasicProfile[];

      out.push({
        gameId: g.gameId,
        week: g.week,
        commence_at: g.commence_at,
        home: g.home,
        away: g.away,
        total: g.total,
        homeCount: g.homeCount,
        awayCount: g.awayCount,
        homePct,
        awayPct,
        followersHome,
        followersAway,
      });
    }

    out.sort(
      (a, b) =>
        new Date(b.commence_at).getTime() -
        new Date(a.commence_at).getTime()
    );

    return out;
  }, [picks, followingIds, profileById]);

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

  if (!picks.length && !bets.length) {
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
              {games.length}
            </span>{" "}
            games with graded picks
            {scope === "following" && bets.length > 0 && (
              <>
                {" "}
                ·{" "}
                <span className="font-semibold text-slate-100">
                  {bets.length}
                </span>{" "}
                mutual bets
              </>
            )}
            .
          </div>
        </div>
      </header>

      {/* Mutuals' bets section (Following scope only) */}
      {scope === "following" && bets.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
            Mutuals' Bets (Units)
          </h2>
          <ul className="space-y-3">
            {bets.map((b) => {
              const prof = profileById.get(b.user_id);
              const when = (b.event_date || b.created_at)
                ? new Date(b.event_date || b.created_at).toLocaleString()
                : "";

              const handleUrlSlug =
                prof?.username && prof.username.trim().length > 0
                  ? prof.username.trim()
                  : prof?.id ?? b.user_id;

              const effectiveUnitSize =
                unitSize && unitSize > 0 ? unitSize : null;
              const stakeUnits = effectiveUnitSize
                ? Number(b.stake) / effectiveUnitSize
                : null;
              const resultUnits = effectiveUnitSize
                ? Number(b.result_amount) / effectiveUnitSize
                : null;

              const statusLabel = b.status === "pending" ? "Pending" : b.status;

              return (
                <li
                  key={`bet-${b.id}`}
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
                          {prof?.username ?? `user_${b.user_id.slice(0, 6)}`}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          Bet placed {when}
                        </span>
                      </div>
                    </Link>

                    {/* Right: bet details – shown in units, not dollars */}
                    <div className="text-right text-[11px] sm:text-xs text-slate-300">
                      <div className="mb-0.5">
                        <span className="font-semibold text-yellow-300">
                          {b.event_name}
                        </span>
                      </div>
                      <div className="text-slate-400">
                        {b.selection} @{" "}
                        {b.odds_american !== null
                          ? fmtSigned(b.odds_american)
                          : "—"}
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500">
                        Stake:{" "}
                        {stakeUnits !== null
                          ? `${stakeUnits.toFixed(2)}u`
                          : "—u"}
                      </div>
                      <div className="mt-0.5 text-[10px]">
                        {b.status === "pending" || resultUnits === null ? (
                          <span className="text-slate-400">
                            {statusLabel}
                          </span>
                        ) : (
                          <span
                            className={
                              resultUnits > 0
                                ? "text-emerald-400"
                                : resultUnits < 0
                                ? "text-rose-400"
                                : "text-slate-300"
                            }
                          >
                            {`${resultUnits >= 0 ? "+" : ""}${resultUnits.toFixed(
                              2
                            )}u`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Game-level splits section */}
      <section>
        <h2 className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
          Game Split — {windowLabel}
        </h2>
        <ul className="space-y-3">
          {games.map((g) => {
            const when = new Date(g.commence_at).toLocaleString();

            return (
              <li
                key={g.gameId}
                className="rounded-2xl p-3 sm:p-4 bg-slate-950/80 border border-slate-800 shadow-sm shadow-black/30"
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Left: matchup + meta */}
                  <div className="flex flex-col text-[11px] sm:text-xs text-slate-300">
                    <div className="text-sm sm:text-base font-semibold text-slate-100">
                      {g.away} @ {g.home}
                    </div>
                    <div className="text-slate-500 mt-0.5">
                      NFL • Week {g.week} • Kicked off {when}
                    </div>
                    <div className="text-slate-500 text-[10px] mt-0.5">
                      {g.total} picks logged
                    </div>
                  </div>

                  {/* Right: side percentages + your follows */}
                  <div className="text-right text-[11px] sm:text-xs text-slate-300 w-40">
                    {/* Home side */}
                    <div className="mb-2">
                      <div className="flex justify-between mb-0.5">
                        <span className="text-slate-400">{g.home}</span>
                        <span className="font-mono">
                          {g.homePct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-yellow-400"
                          style={{ width: `${g.homePct}%` }}
                        />
                      </div>
                      {g.followersHome.length > 0 && (
                        <div className="mt-0.5 text-[10px] text-slate-400">
                          Your follows on home:{" "}
                          <span className="text-slate-100">
                            {g.followersHome
                              .slice(0, 3)
                              .map((p) => p.username ?? p.id.slice(0, 6))
                              .join(", ")}
                            {g.followersHome.length > 3 &&
                              ` +${g.followersHome.length - 3} more`}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Away side */}
                    <div>
                      <div className="flex justify-between mb-0.5">
                        <span className="text-slate-400">{g.away}</span>
                        <span className="font-mono">
                          {g.awayPct.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-yellow-400"
                          style={{ width: `${g.awayPct}%` }}
                        />
                      </div>
                      {g.followersAway.length > 0 && (
                        <div className="mt-0.5 text-[10px] text-slate-400">
                          Your follows on away:{" "}
                          <span className="text-slate-100">
                            {g.followersAway
                              .slice(0, 3)
                              .map((p) => p.username ?? p.id.slice(0, 6))
                              .join(", ")}
                            {g.followersAway.length > 3 &&
                              ` +${g.followersAway.length - 3} more`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
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