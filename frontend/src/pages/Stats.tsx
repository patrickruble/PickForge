// src/pages/Stats.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import {
  League,
  GameRow,
  PickRow,
  PickWithGame,
  Grade,
  gradePick,
  classifyDogFav,
  formatLine,
} from "../lib/pickGrading";

type SplitRecord = {
  wins: number;
  losses: number;
  pushes: number;
  total: number;
};

type AggregateStats = {
  totalGraded: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  home: SplitRecord;
  away: SplitRecord;
  underdog: SplitRecord;
  favorite: SplitRecord;
  spread: SplitRecord;
  moneyline: SplitRecord;
};

const league: League = "nfl";

function emptyRecord(): SplitRecord {
  return { wins: 0, losses: 0, pushes: 0, total: 0 };
}

function applyResult(rec: SplitRecord, g: Grade) {
  if (g === "win") rec.wins += 1;
  else if (g === "loss") rec.losses += 1;
  else if (g === "push") rec.pushes += 1;
  rec.total = rec.wins + rec.losses + rec.pushes;
}

export default function Stats() {
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [rows, setRows] = useState<PickWithGame[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNeedsLogin(false);

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
        setUserId(null);
        setNeedsLogin(true);
        setLoading(false);
        return;
      }

      setUserId(user.id);

      const { data: picksRaw, error: picksError } = await supabase
        .from("picks")
        .select(
          "id,user_id,league,week,game_id,side,picked_price_type,picked_price"
        )
        .eq("user_id", user.id)
        .eq("league", league);

      if (!mounted) return;

      if (picksError) {
        console.error("[Stats] picks error:", picksError);
        setError("Failed to load your picks. Please try again later.");
        setLoading(false);
        return;
      }

      const picks = (picksRaw ?? []) as PickRow[];

      if (picks.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }

      const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));

      let games: GameRow[] = [];
      if (gameIds.length > 0) {
        const { data: gamesRaw, error: gamesError } = await supabase
          .from("games")
          .select(
            "id,week,league,home_team,away_team,home_score,away_score,status"
          )
          .in("id", gameIds);

        if (!mounted) return;

        if (gamesError) {
          console.error("[Stats] games error:", gamesError);
          setError("Failed to load game results. Please try again later.");
          setLoading(false);
          return;
        }

        games = (gamesRaw ?? []) as GameRow[];
      }

      const gameMap = new Map<string, GameRow>();
      for (const g of games) {
        gameMap.set(g.id, g);
      }

      const combined: PickWithGame[] = picks.map((p) => ({
        ...p,
        game: gameMap.get(p.game_id) ?? null,
      }));

      setRows(combined);
      setLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  const aggregate: AggregateStats = useMemo(() => {
    const base: AggregateStats = {
      totalGraded: 0,
      wins: 0,
      losses: 0,
      pushes: 0,
      winRate: 0,
      home: emptyRecord(),
      away: emptyRecord(),
      underdog: emptyRecord(),
      favorite: emptyRecord(),
      spread: emptyRecord(),
      moneyline: emptyRecord(),
    };

    for (const row of rows) {
      const g = gradePick(row);
      if (g === "pending") continue;

      base.totalGraded += 1;
      if (g === "win") base.wins += 1;
      else if (g === "loss") base.losses += 1;
      else if (g === "push") base.pushes += 1;

      if (row.side === "home") {
        applyResult(base.home, g);
      } else if (row.side === "away") {
        applyResult(base.away, g);
      }

      const df = classifyDogFav(row);
      if (df === "underdog") applyResult(base.underdog, g);
      else if (df === "favorite") applyResult(base.favorite, g);

      if (row.picked_price_type === "spread") {
        applyResult(base.spread, g);
      } else if (row.picked_price_type === "ml") {
        applyResult(base.moneyline, g);
      }
    }

    const denom = base.wins + base.losses;
    base.winRate = denom > 0 ? (base.wins / denom) * 100 : 0;

    return base;
  }, [rows]);

  const gradedRows = useMemo(
    () =>
      rows
        .slice()
        .sort((a, b) => {
          const wa = a.game?.week ?? a.week;
          const wb = b.game?.week ?? b.week;
          return wb - wa;
        }),
    [rows]
  );

  // Unique list of weeks (most recent first)
  const weeks = useMemo(() => {
    const set = new Set<number>();
    for (const p of gradedRows) {
      const w = p.game?.week ?? p.week;
      if (typeof w === "number") {
        set.add(w);
      }
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [gradedRows]);

  // Selected week for detailed breakdown (defaults to most recent)
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  // Mode for breakdown: show all picks vs moneyline-only (Moneyline Mastery)
  const [breakdownMode, setBreakdownMode] = useState<"all" | "mm">("all");

  useEffect(() => {
    if (!weeks.length) return;
    if (selectedWeek === null) {
      setSelectedWeek(weeks[0]);
    }
  }, [weeks, selectedWeek]);

  // Picks visible in the breakdown table for the selected week + mode
  const visiblePicks = useMemo(() => {
    const base =
      selectedWeek === null
        ? rows
        : rows.filter((p) => (p.game?.week ?? p.week) === selectedWeek);

    if (breakdownMode === "mm") {
      // Moneyline-only picks (what Moneyline Mastery actually uses)
      return base.filter(
        (p) => p.picked_price_type === "ml" && p.picked_price != null
      );
    }

    // All picks
    return base;
  }, [rows, selectedWeek, breakdownMode]);

  // Count of ML picks for the selected week (used in helper text)
  const mlCountForSelectedWeek = useMemo(() => {
    const base =
      selectedWeek === null
        ? rows
        : rows.filter((p) => (p.game?.week ?? p.week) === selectedWeek);
    return base.filter(
      (p) => p.picked_price_type === "ml" && p.picked_price != null
    ).length;
  }, [rows, selectedWeek]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading your stats...
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

  if (!rows.length) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">No picks yet</p>
          <p>
            Once you start making picks and games go final, your record and
            breakdowns will appear here.
          </p>
        </div>
      </div>
    );
  }

  const overallWinRateLabel =
    aggregate.totalGraded === 0 ? "—" : `${aggregate.winRate.toFixed(1)}%`;

  const formatSplit = (rec: SplitRecord) =>
    rec.total === 0
      ? "0-0"
      : `${rec.wins}-${rec.losses}${rec.pushes ? `-${rec.pushes}` : ""}`;

  return (
    <div className="max-w-5xl mx-auto px-4 py-10 text-slate-200">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h1 className="text-3xl font-bold text-yellow-400">Your Stats</h1>
        {userId && (
          <Link
            to={`/u/${userId}`}
            className="text-xs text-yellow-400 hover:text-yellow-300"
          >
            View Profile →
          </Link>
        )}
      </div>

      {/* Top summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-8">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Graded Picks
          </p>
          <p className="text-2xl mt-1 font-bold">{aggregate.totalGraded}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Win Rate
          </p>
          <p className="text-2xl mt-1 font-bold">{overallWinRateLabel}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Underdog Record
          </p>
          <p className="text-2xl mt-1 font-bold">
            {formatSplit(aggregate.underdog)}
          </p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Favorite Record
          </p>
          <p className="text-2xl mt-1 font-bold">
            {formatSplit(aggregate.favorite)}
          </p>
        </div>
      </div>

      {/* Secondary splits */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-10">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Home Side
          </p>
          <p className="text-lg mt-1 font-bold">
            {formatSplit(aggregate.home)}
          </p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Away Side
          </p>
          <p className="text-lg mt-1 font-bold">
            {formatSplit(aggregate.away)}
          </p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Spread Picks
          </p>
          <p className="text-lg mt-1 font-bold">
            {formatSplit(aggregate.spread)}
          </p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Moneyline Picks
          </p>
          <p className="text-lg mt-1 font-bold">
            {formatSplit(aggregate.moneyline)}
          </p>
        </div>
      </div>

      {/* Detailed picks table */}
      <div className="bg-slate-900/70 rounded-xl border border-slate-700 p-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold">Pick breakdown</h2>
          {weeks.length > 0 && selectedWeek !== null && (
            <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 text-[11px] sm:text-xs text-slate-300">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Week:</span>
                <select
                  aria-label="Select week for pick breakdown"
                  value={selectedWeek}
                  onChange={(e) => setSelectedWeek(Number(e.target.value))}
                  className="bg-slate-900 border border-slate-700 rounded-full px-2 py-1 text-[11px] sm:text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-yellow-400"
                >
                  {weeks.map((w) => (
                    <option key={w} value={w}>
                      Week {w}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
                <button
                  type="button"
                  onClick={() => setBreakdownMode("all")}
                  className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                    breakdownMode === "all"
                      ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                      : "text-slate-300 hover:text-slate-100"
                  }`}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setBreakdownMode("mm")}
                  className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                    breakdownMode === "mm"
                      ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                      : "text-slate-300 hover:text-slate-100"
                  }`}
                >
                  MM
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400 mb-3">
          Viewing{" "}
          {breakdownMode === "mm" ? "moneyline-only picks" : "all picks"} for{" "}
          {selectedWeek !== null ? `Week ${selectedWeek}` : "recent weeks"}.{" "}
          Result and "Covered" are only shown once a game is final.
          {breakdownMode === "mm" && mlCountForSelectedWeek === 0 && (
            <> You don&apos;t have any moneyline picks for this week yet, so there&apos;s nothing to show here.</>
          )}
          {breakdownMode === "mm" && mlCountForSelectedWeek > 0 && (
            <> Moneyline Mastery uses these graded moneyline picks.</>
          )}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-slate-400 text-[11px] uppercase border-b border-slate-700">
              <tr>
                <th className="text-left py-2 pr-3">Week</th>
                <th className="text-left py-2 pr-3">Matchup</th>
                <th className="text-left py-2 pr-3">Side</th>
                <th className="text-left py-2 pr-3">Dog/Fav</th>
                <th className="text-right py-2 px-3">Type</th>
                <th className="text-right py-2 px-3">Line/Odds</th>
                <th className="text-right py-2 px-3">Result</th>
                <th className="text-right py-2 pl-3">Covered</th>
              </tr>
            </thead>
            <tbody>
              {visiblePicks.map((p) => {
                const g = gradePick(p);
                const game = p.game;
                const week = game?.week ?? p.week;
                const home = game?.home_team ?? "Home";
                const away = game?.away_team ?? "Away";

                const isHome = p.side === "home";
                const pickedTeam = isHome ? home : away;

                const dogFav = classifyDogFav(p);
                const dogFavLabel =
                  dogFav === "underdog"
                    ? "Underdog"
                    : dogFav === "favorite"
                    ? "Favorite"
                    : dogFav === "even"
                    ? "Even"
                    : "-";

                const typeLabel =
                  p.picked_price_type === "spread"
                    ? "Spread"
                    : p.picked_price_type === "ml"
                    ? "ML"
                    : "-";

                const lineLabel = formatLine(p);

                let resultLabel = "-";
                if (g === "win") resultLabel = "Win";
                else if (g === "loss") resultLabel = "Loss";
                else if (g === "push") resultLabel = "Push";
                else if (g === "pending") resultLabel = "Pending";

                const coveredLabel =
                  p.picked_price_type === "spread" && g !== "pending"
                    ? g === "win"
                      ? "Covered"
                      : g === "loss"
                      ? "Did not cover"
                      : "Push"
                    : "-";

                const resultColor =
                  g === "win"
                    ? "text-emerald-300"
                    : g === "loss"
                    ? "text-rose-300"
                    : g === "push"
                    ? "text-slate-200"
                    : "text-slate-400";

                return (
                  <tr
                    key={p.id}
                    className="border-b border-slate-800/70 last:border-0"
                  >
                    <td className="py-2 pr-3 align-top">Week {week}</td>
                    <td className="py-2 pr-3 align-top">
                      <div className="font-medium text-slate-100">
                        {away} at {home}
                      </div>
                      {game &&
                        game.home_score != null &&
                        game.away_score != null && (
                          <div className="text-[11px] text-slate-500">
                            Final {home} {game.home_score} – {away}{" "}
                            {game.away_score}
                          </div>
                        )}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      {pickedTeam}
                      <span className="text-[11px] text-slate-500 ml-1">
                        ({isHome ? "Home" : "Away"})
                      </span>
                    </td>
                    <td className="py-2 pr-3 align-top">{dogFavLabel}</td>
                    <td className="py-2 px-3 text-right align-top">
                      {typeLabel}
                    </td>
                    <td className="py-2 px-3 text-right align-top">
                      {lineLabel}
                    </td>
                    <td className="py-2 px-3 text-right align-top">
                      <span className={resultColor}>{resultLabel}</span>
                    </td>
                    <td className="py-2 pl-3 text-right align-top">
                      {coveredLabel}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}