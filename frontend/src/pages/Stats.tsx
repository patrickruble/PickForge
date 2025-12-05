// src/pages/Stats.tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type PickRow = {
  id: string;
  user_id: string;
  league: string;
  week: number;
  game_id: string;
  side: string; // expecting "home" | "away" for now
  // other fields exist but we don't need them here
  // commence_at: string;
  // locked: boolean;
};

type GameRow = {
  id: string;
  week: number;
  home_score: number | null;
  away_score: number | null;
  status: string;
};

type WeeklyStats = {
  week: number;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winPct: number;
};

type BasicStats = {
  totalPicks: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  weekly: WeeklyStats[];
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
        };
        setStats(empty);
        setLoading(false);
        return;
      }

      // 3) Fetch the games for those picks
      const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));

      const { data: gamesRaw, error: gamesError } = await supabase
        .from("games")
        // include status now
        .select("id,week,home_score,away_score,status")
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

        let isWin = false;
        let isLoss = false;
        let isPush = false;

        if (winner === "push") {
          isPush = true;
        } else if (winner === p.side) {
          isWin = true;
        } else {
          isLoss = true;
        }

        if (isWin) wins++;
        if (isLoss) losses++;
        if (isPush) pushes++;

        const wk = g.week ?? p.week;
        const entry =
          weeklyMap.get(wk) ?? { wins: 0, losses: 0, pushes: 0 };
        if (isWin) entry.wins++;
        if (isLoss) entry.losses++;
        if (isPush) entry.pushes++;
        weeklyMap.set(wk, entry);
      }

      const totalPicks = wins + losses + pushes;
      const winRate = safePct(wins, wins + losses) * 100;

      const weekly: WeeklyStats[] = Array.from(weeklyMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([week, { wins, losses, pushes }]) => {
          const total = wins + losses + pushes;
          const winPct = safePct(wins, wins + losses) * 100;
          return { week, wins, losses, pushes, total, winPct };
        });

      const basic: BasicStats = {
        totalPicks,
        wins,
        losses,
        pushes,
        winRate,
        weekly,
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
    // should basically never happen, but just in case
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Couldn’t load stats.
        </div>
      </div>
    );
  }

  // ---------- MAIN UI ----------

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <h1 className="text-3xl font-bold text-yellow-400 mb-6">Your Stats</h1>

      {/* Top summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-10">
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

      {/* Weekly breakdown */}
      <div className="bg-slate-900/70 rounded-xl border border-slate-700 p-6">
        <h2 className="text-lg font-semibold mb-3">Weekly breakdown</h2>

        {stats.weekly.length === 0 ? (
          <p className="text-sm text-slate-400">
            Once your games finish and we have final scores, your record by
            week will show up here.
          </p>
        ) : (
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
                {stats.weekly.map((w) => (
                  <tr
                    key={w.week}
                    className="border-b border-slate-800/70 last:border-0"
                  >
                    <td className="py-2 pr-4">Week {w.week}</td>
                    <td className="py-2 px-2 text-right">
                      {w.wins}-{w.losses}
                    </td>
                    <td className="py-2 px-2 text-right">{w.pushes}</td>
                    <td className="py-2 px-2 text-right">{w.total}</td>
                    <td className="py-2 pl-2 text-right">
                      {w.total === 0 ? "—" : `${w.winPct.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}