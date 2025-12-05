// src/pages/Stats.tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type PickRow = {
  id: string;
  user_id: string;
  league: string;
  week: number;
  game_id: string;
  side: "home" | "away"; // expecting "home" | "away"
};

type GameRow = {
  id: string;
  week: number;
  home_score: number | null;
  away_score: number | null;
  status: string;
  home_team: string;
  away_team: string;
};

type WeeklyStats = {
  week: number;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winPct: number;
};

type WeekPickDetail = {
  pickId: string;
  league: string;
  side: "home" | "away";
  result: "W" | "L" | "P";
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
};

type BasicStats = {
  totalPicks: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  weekly: WeeklyStats[];
  currentStreakType: "W" | "L" | null;
  currentStreakLen: number;
  bestStreakType: "W" | "L" | null;
  bestStreakLen: number;
  weeklyDetails: Record<number, WeekPickDetail[]>;
};

function safePct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

export default function Stats() {
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [stats, setStats] = useState<BasicStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNeedsLogin(false);

      // 1) Get current user
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        console.error("[Stats] getSession error:", sessionError);
      }

      const user = session?.user ?? null;

      if (!user) {
        if (!mounted) return;
        setNeedsLogin(true);
        setLoading(false);
        return;
      }

      // 2) Fetch this user's picks
      const { data: picksRaw, error: picksError } = await supabase
        .from("picks")
        .select("id,user_id,league,week,game_id,side")
        .eq("user_id", user.id);

      if (!mounted) return;

      if (picksError) {
        console.error("[Stats] picks error:", picksError);
        setError("Failed to load your picks. Please try again later.");
        setLoading(false);
        return;
      }

      const picks = (picksRaw ?? []) as PickRow[];

      if (picks.length === 0) {
        const empty: BasicStats = {
          totalPicks: 0,
          wins: 0,
          losses: 0,
          pushes: 0,
          winRate: 0,
          weekly: [],
          currentStreakType: null,
          currentStreakLen: 0,
          bestStreakType: null,
          bestStreakLen: 0,
          weeklyDetails: {},
        };
        setStats(empty);
        setLoading(false);
        return;
      }

      // 3) Fetch the games for those picks
      const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));

      const { data: gamesRaw, error: gamesError } = await supabase
        .from("games")
        .select(
          "id,week,home_score,away_score,status,home_team,away_team"
        )
        .in("id", gameIds);

      if (!mounted) return;

      if (gamesError) {
        console.error("[Stats] games error:", gamesError);
        setError("Failed to load game results. Please try again later.");
        setLoading(false);
        return;
      }

      const games = (gamesRaw ?? []) as GameRow[];

      // 4) Compute stats locally
      const gameMap = new Map<string, GameRow>();
      for (const g of games) {
        gameMap.set(g.id, g);
      }

      let wins = 0;
      let losses = 0;
      let pushes = 0;

      const weeklyMap = new Map<
        number,
        { wins: number; losses: number; pushes: number }
      >();

      type Result = "W" | "L" | "P";
      const chronologicalResults: { week: number; res: Result }[] = [];

      const weeklyDetailsMap = new Map<number, WeekPickDetail[]>();

      for (const p of picks) {
        const g = gameMap.get(p.game_id);
        if (!g) continue;

        const { home_score, away_score, status } = g;

        // only count finished games with final scores
        if (status !== "final" || home_score === null || away_score === null) {
          continue;
        }

        let winner: "home" | "away" | "push";
        if (home_score > away_score) winner = "home";
        else if (away_score > home_score) winner = "away";
        else winner = "push";

        let res: Result;
        if (winner === "push") {
          res = "P";
          pushes++;
        } else if (winner === p.side) {
          res = "W";
          wins++;
        } else {
          res = "L";
          losses++;
        }

        const wk = g.week ?? p.week;

        // aggregate weekly W/L/P
        const entry =
          weeklyMap.get(wk) ?? { wins: 0, losses: 0, pushes: 0 };
        if (res === "W") entry.wins++;
        else if (res === "L") entry.losses++;
        else entry.pushes++;
        weeklyMap.set(wk, entry);

        // chronological streak data
        chronologicalResults.push({ week: wk, res });

        // weekly details list
        const detailArr = weeklyDetailsMap.get(wk) ?? [];
        detailArr.push({
          pickId: p.id,
          league: p.league,
          side: p.side,
          result: res,
          home_team: g.home_team,
          away_team: g.away_team,
          home_score,
          away_score,
        });
        weeklyDetailsMap.set(wk, detailArr);
      }

      const totalPicks = wins + losses + pushes;
      const winRate = safePct(wins, wins + losses) * 100;

      // 4b) Compute streaks (pushes don't break streak)
      let currentType: "W" | "L" | null = null;
      let currentLen = 0;
      let bestType: "W" | "L" | null = null;
      let bestLen = 0;

      // sort by week so it's deterministic
      chronologicalResults.sort((a, b) => a.week - b.week);

      for (const { res } of chronologicalResults) {
        if (res === "P") continue;

        if (!currentType || currentType !== res) {
          currentType = res;
          currentLen = 1;
        } else {
          currentLen++;
        }

        if (currentLen > bestLen) {
          bestLen = currentLen;
          bestType = currentType;
        }
      }

      const weekly: WeeklyStats[] = Array.from(weeklyMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([week, { wins, losses, pushes }]) => {
          const total = wins + losses + pushes;
          const winPct = safePct(wins, wins + losses) * 100;
          return { week, wins, losses, pushes, total, winPct };
        });

      const weeklyDetails: Record<number, WeekPickDetail[]> = {};
      for (const [week, arr] of weeklyDetailsMap.entries()) {
        weeklyDetails[week] = arr;
      }

      const basic: BasicStats = {
        totalPicks,
        wins,
        losses,
        pushes,
        winRate,
        weekly,
        currentStreakType: currentType,
        currentStreakLen: currentLen,
        bestStreakType: bestType,
        bestStreakLen: bestLen,
        weeklyDetails,
      };

      setStats(basic);
      setLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  // ---------- RENDER STATES ----------

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading your stats…
        </div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Stats</p>
          <p>You must be logged in to view your stats.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-red-500/60 text-center">
          <p className="mb-2 font-semibold text-red-400">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Couldn’t load stats.
        </div>
      </div>
    );
  }

  const formatStreak = (type: "W" | "L" | null, len: number) => {
    if (!type || len === 0) return "—";
    return `${type}${len}`;
  };

  const expandedDetails =
    expandedWeek != null ? stats.weeklyDetails[expandedWeek] ?? [] : [];

  // ---------- MAIN UI ----------

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <h1 className="text-3xl font-bold text-yellow-400 mb-6">Your Stats</h1>

      {/* Top summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-6">
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
            Wins
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.wins}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Losses
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.losses}</p>
        </div>
      </div>

      {/* Streak cards */}
      <div className="grid grid-cols-2 gap-5 mb-10">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Current Streak
          </p>
          <p className="text-2xl mt-1 font-bold">
            {formatStreak(stats.currentStreakType, stats.currentStreakLen)}
          </p>
        </div>
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Best Streak
          </p>
          <p className="text-2xl mt-1 font-bold">
            {formatStreak(stats.bestStreakType, stats.bestStreakLen)}
          </p>
        </div>
      </div>

      {/* Weekly breakdown + drilldown */}
      <div className="bg-slate-900/70 rounded-xl border border-slate-700 p-6">
        <h2 className="text-lg font-semibold mb-3">Weekly breakdown</h2>

        {stats.weekly.length === 0 ? (
          <p className="text-sm text-slate-400">
            Once your games finish and we have final scores, your record by
            week will show up here.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase border-b border-slate-700">
                  <tr>
                    <th className="text-left py-2 pr-4">Week</th>
                    <th className="text-right py-2 px-2">Record</th>
                    <th className="text-right py-2 px-2">Pushes</th>
                    <th className="text-right py-2 px-2">Total</th>
                    <th className="text-right py-2 pl-2">Win %</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.weekly.map((w) => {
                    const isActive = expandedWeek === w.week;
                    return (
                      <tr
                        key={w.week}
                        className={`border-b border-slate-800/70 last:border-0 cursor-pointer transition ${
                          isActive ? "bg-slate-800/60" : "hover:bg-slate-800/40"
                        }`}
                        onClick={() =>
                          setExpandedWeek(
                            isActive ? null : w.week
                          )
                        }
                      >
                        <td className="py-2 pr-4">
                          <span className="mr-2 text-xs text-slate-500">
                            {isActive ? "▾" : "▸"}
                          </span>
                          Week {w.week}
                        </td>
                        <td className="py-2 px-2 text-right">
                          {w.wins}-{w.losses}
                        </td>
                        <td className="py-2 px-2 text-right">{w.pushes}</td>
                        <td className="py-2 px-2 text-right">{w.total}</td>
                        <td className="py-2 pl-2 text-right">
                          {w.total === 0 ? "—" : `${w.winPct.toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {expandedWeek != null && expandedDetails.length > 0 && (
              <div className="mt-5 border-t border-slate-800/80 pt-4">
                <h3 className="text-sm font-semibold mb-3 text-slate-100">
                  Week {expandedWeek} picks
                </h3>
                <div className="space-y-2">
                  {expandedDetails.map((p) => {
                    const isHome = p.side === "home";
                    const pickedTeam = isHome ? p.home_team : p.away_team;
                    const otherTeam = isHome ? p.away_team : p.home_team;
                    const pickedScore = isHome
                      ? p.home_score
                      : p.away_score;
                    const otherScore = isHome
                      ? p.away_score
                      : p.home_score;

                    const badgeColor =
                      p.result === "W"
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                        : p.result === "L"
                        ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
                        : "bg-slate-500/20 text-slate-200 border-slate-500/40";

                    const resultLabel =
                      p.result === "W" ? "Win" : p.result === "L" ? "Loss" : "Push";

                    return (
                      <div
                        key={p.pickId}
                        className="flex items-center justify-between text-xs sm:text-sm bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-100">
                            {pickedTeam}{" "}
                            <span className="text-slate-500 text-[11px]">
                              vs {otherTeam}
                            </span>
                          </span>
                          <span className="text-[11px] text-slate-400">
                            Final {p.home_team} {p.home_score} –{" "}
                            {p.away_team} {p.away_score}
                          </span>
                        </div>
                        <div
                          className={`ml-3 px-2 py-0.5 rounded-full text-[11px] border ${badgeColor}`}
                        >
                          {resultLabel}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {expandedWeek != null && expandedDetails.length === 0 && (
              <div className="mt-4 text-xs text-slate-400">
                No graded picks for this week yet.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}