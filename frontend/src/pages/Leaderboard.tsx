import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Link } from "react-router-dom";
import { useAllUserStats } from "../hooks/useAllUserStats";
import {
  getNflWeekNumber,
  currentNflWeekWindow,
} from "../hooks/useRemotePicks";

type League = "nfl" | "ncaaf";

type ProfileInfo = {
  username: string | null;
  avatar_url: string | null;
};

type GameRow = {
  id: string;
  status: string | null;
  home_score: number | null;
  away_score: number | null;
};

type PickRow = {
  user_id: string;
  game_id: string;
  week: number;
  league: League;
  side: "home" | "away";
  picked_price_type: "ml" | "spread" | null;
  picked_price: number | null;
};

type PickWithGame = PickRow & {
  game: GameRow | null;
};

type LeaderItem = {
  user_id: string;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winPct: number; // stored as 0–1 (fraction) for both week + season
  profile?: ProfileInfo;
};

type Grade = "pending" | "win" | "loss" | "push";

const league: League = "nfl";

function gradePick(row: PickWithGame): Grade {
  const game = row.game;
  if (!game || game.status !== "final") return "pending";

  const home = game.home_score ?? null;
  const away = game.away_score ?? null;
  if (home == null || away == null) return "pending";

  const pickedScore = row.side === "home" ? home : away;
  const otherScore = row.side === "home" ? away : home;

  // Moneyline or missing spread → straight-up winner
  if (row.picked_price_type === "ml" || row.picked_price == null) {
    if (pickedScore > otherScore) return "win";
    if (pickedScore < otherScore) return "loss";
    return "push";
  }

  // Against the spread: picked_price is line on picked side
  const spread = row.picked_price;
  const spreadDiff = pickedScore + spread - otherScore;
  if (spreadDiff > 0) return "win";
  if (spreadDiff < 0) return "loss";
  return "push";
}

export default function Leaderboard() {
  const week = useMemo(() => getNflWeekNumber(new Date()), []);
  const [rows, setRows] = useState<PickWithGame[]>([]);
  const [loading, setLoading] = useState(true);

  const [profilesMap, setProfilesMap] = useState<Record<string, ProfileInfo>>(
    {}
  );

  // 🔀 View toggle: week vs season
  const [viewMode, setViewMode] = useState<"week" | "season">("week");

  // Season-long stats for each user
  const { statsByUser, loading: statsLoading } = useAllUserStats();

  const weekWindow = useMemo(() => {
    const { weekStart, weekEnd } = currentNflWeekWindow(new Date());
    const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${weekStart.toLocaleDateString(
      undefined,
      fmt
    )} – ${weekEnd.toLocaleDateString(undefined, fmt)}`;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      // picks for this week
      const { data: pickData, error: pickError } = await supabase
        .from("picks")
        .select(
          "user_id, game_id, week, league, side, picked_price_type, picked_price"
        )
        .eq("league", league)
        .eq("week", week);

      if (pickError) {
        console.error("[Leaderboard] picks load error:", pickError);
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
        return;
      }

      const picks = (pickData ?? []) as PickRow[];

      // games for this week
      const { data: gameData, error: gameError } = await supabase
        .from("games")
        .select("id, status, home_score, away_score, week, league")
        .eq("league", league)
        .eq("week", week);

      if (gameError) {
        console.error("[Leaderboard] games load error:", gameError);
      }

      const games = (gameData ?? []) as GameRow[];
      const gameMap = new Map<string, GameRow>();
      for (const g of games) gameMap.set(g.id, g);

      const combined: PickWithGame[] = picks.map((p) => ({
        ...p,
        game: gameMap.get(p.game_id) ?? null,
      }));

      if (!cancelled) {
        setRows(combined);
        setLoading(false);
      }
    }

    load();

    const channel = supabase
      .channel(`leaderboard-${league}-${week}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "picks" },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [week]);

  //  WEEK AGGREGATED (your existing logic)
  const weekAggregated: LeaderItem[] = useMemo(() => {
    const stats = new Map<string, LeaderItem>();

    for (const r of rows) {
      const g = gradePick(r);
      if (g === "pending") continue;

      if (!stats.has(r.user_id)) {
        stats.set(r.user_id, {
          user_id: r.user_id,
          wins: 0,
          losses: 0,
          pushes: 0,
          total: 0,
          winPct: 0,
          profile: undefined,
        });
      }

      const s = stats.get(r.user_id)!;

      if (g === "win") s.wins += 1;
      else if (g === "loss") s.losses += 1;
      else if (g === "push") s.pushes += 1;

      s.total = s.wins + s.losses + s.pushes;
      s.winPct = s.total > 0 ? s.wins / s.total : 0; // fraction
    }

    const list: LeaderItem[] = [];
    stats.forEach((v, user_id) => {
      list.push({
        ...v,
        profile: profilesMap[user_id],
      });
    });

    list.sort((a, b) => {
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      return b.wins - a.wins;
    });

    return list.slice(0, 100);
  }, [rows, profilesMap]);

  //  SEASON AGGREGATED (from useAllUserStats)
  const seasonAggregated: LeaderItem[] = useMemo(() => {
    const list: LeaderItem[] = [];

    Object.entries(statsByUser).forEach(([user_id, s]) => {
      // ignore users with no finished picks
      if (s.totalPicks === 0) return;

      list.push({
        user_id,
        wins: s.wins,
        losses: s.losses,
        pushes: s.pushes,
        total: s.totalPicks,
        winPct: s.winRate / 100, // convert % to fraction to match week
        profile: profilesMap[user_id],
      });
    });

    list.sort((a, b) => {
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      return b.wins - a.wins;
    });

    return list.slice(0, 100);
  }, [statsByUser, profilesMap]);

  // For loading profiles, consider BOTH week + season users
  const allAggregatedForProfiles: LeaderItem[] = useMemo(() => {
    const map = new Map<string, LeaderItem>();
    for (const item of weekAggregated) map.set(item.user_id, item);
    for (const item of seasonAggregated) {
      if (!map.has(item.user_id)) map.set(item.user_id, item);
    }
    return Array.from(map.values());
  }, [weekAggregated, seasonAggregated]);

  // load profiles
  useEffect(() => {
    const unknownIds = allAggregatedForProfiles
      .filter((i) => profilesMap[i.user_id] === undefined)
      .map((i) => i.user_id);

    if (!unknownIds.length) return;

    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, avatar_url")
        .in("id", unknownIds);

      if (cancelled) return;

      if (error) {
        console.error("[Leaderboard] profiles load error:", error);
        return;
      }

      if (data) {
        const next: Record<string, ProfileInfo> = { ...profilesMap };
        for (const row of data as {
          id: string;
          username: string | null;
          avatar_url: string | null;
        }[]) {
          next[row.id] = {
            username: row.username ?? null,
            avatar_url: row.avatar_url ?? null,
          };
        }
        setProfilesMap(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [allAggregatedForProfiles, profilesMap]);

  const activeAggregated =
    viewMode === "week" ? weekAggregated : seasonAggregated;

  const totalPlayers = useMemo(
    () => new Set(activeAggregated.map((r) => r.user_id)).size,
    [activeAggregated]
  );

  const isWeekView = viewMode === "week";

  // Loading / empty states
  if (isWeekView && loading && !rows.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto font-sans">
        <h1 className="font-display text-3xl sm:text-4xl tracking-[0.18em] uppercase text-yellow-400 mb-1 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Leaderboard
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mb-4">
          NFL Week {week} · {weekWindow}
        </p>
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse rounded-xl bg-slate-800/70 h-14"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!activeAggregated.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto font-sans">
        <h1 className="font-display text-3xl sm:text-4xl tracking-[0.18em] uppercase text-yellow-400 mb-1 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Leaderboard
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mb-4">
          {isWeekView
            ? `NFL Week ${week} · ${weekWindow}`
            : "Season Leaderboard"}
        </p>
        <p className="text-slate-300 text-sm">
          {isWeekView
            ? "No games have finished yet this week, so records haven’t been graded."
            : statsLoading
            ? "Loading season stats…"
            : "No finished games yet this season, so season records aren’t available."}
        </p>
      </div>
    );
  }

  // Main UI
  return (
    <section className="px-3 py-5 sm:px-4 sm:py-6 max-w-4xl mx-auto font-sans">
      <header className="mb-4 sm:mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-4xl tracking-[0.18em] uppercase text-yellow-400 leading-tight drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
            Leaderboard
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            {isWeekView
              ? `NFL Week ${week} · ${weekWindow}`
              : "Season results across all finished weeks"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] sm:text-xs text-slate-300 items-center">
          <div className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80">
            <span className="font-semibold text-slate-100">
              {totalPlayers}
            </span>{" "}
            players
          </div>

          {/* Toggle */}
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
            <button
              onClick={() => setViewMode("week")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                isWeekView
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              Week
            </button>
            <button
              onClick={() => setViewMode("season")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                !isWeekView
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              Season
            </button>
          </div>
        </div>
      </header>

      <div className="hidden sm:grid grid-cols-[auto,1fr,auto] text-[11px] uppercase tracking-wide text-slate-500 px-3 pb-1">
        <span>Rank</span>
        <span>Player</span>
        <span className="text-right">
          {isWeekView ? "Week Record" : "Season Record"}
        </span>
      </div>

      <ol className="space-y-2 sm:space-y-3">
        {activeAggregated.map((item, idx) => {
          const profile = item.profile;
          const username = profile?.username ?? null;
          const label =
            username && username.trim().length > 0
              ? username
              : `user_${item.user_id.slice(0, 6)}`;

          const initial = (label[0] ?? "?").toUpperCase();
          const rank = idx + 1;

          const rankStyles =
            rank === 1
              ? "border-yellow-400/80 shadow-[0_0_18px_rgba(250,204,21,0.25)]"
              : rank === 2
              ? "border-slate-400/70"
              : rank === 3
              ? "border-amber-600/70"
              : "border-slate-700/60";

          // Week stats from weekAggregated (if user appears there)
          const weekItem = weekAggregated.find(
            (w) => w.user_id === item.user_id
          );
          const weekRecordText = weekItem
            ? `${weekItem.wins}-${weekItem.losses}${
                weekItem.pushes ? `-${weekItem.pushes}` : ""
              }`
            : "0-0";
          const weekWinPctText = weekItem
            ? `${(weekItem.winPct * 100).toFixed(1)}%`
            : "—";

          // Season stats from statsByUser
          const seasonStats = statsByUser[item.user_id];
          const seasonRecordText = seasonStats
            ? `${seasonStats.wins}-${seasonStats.losses}${
                seasonStats.pushes ? `-${seasonStats.pushes}` : ""
              }`
            : "—";

          const seasonWinPctText =
            seasonStats && (seasonStats.wins + seasonStats.losses) > 0
              ? `${seasonStats.winRate.toFixed(1)}%`
              : "—";

          const seasonStreakText =
            seasonStats && seasonStats.currentStreakType
              ? `${seasonStats.currentStreakType}${seasonStats.currentStreakLen}`
              : "—";

          // Primary display based on view
          const primaryRecordText = isWeekView
            ? weekRecordText
            : seasonRecordText;
          const primaryWinPctText = isWeekView
            ? weekWinPctText
            : seasonWinPctText;

          return (
            <li
              key={item.user_id}
              className={`rounded-2xl bg-slate-900/80 border ${rankStyles} px-3 py-2 sm:px-4 sm:py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3`}
            >
              {/*  CLICKABLE PLAYER AREA */}
              <Link
                to={`/u/${item.user_id}`}
                className="flex items-center gap-3 min-w-0 flex-shrink-0 hover:opacity-90 transition"
              >
                <div className="w-7 text-[11px] font-semibold text-slate-500 text-right">
                  #{rank}
                </div>
                <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-100 border border-slate-700 flex-shrink-0">
                  {profile?.avatar_url ? (
                    <img
                      src={profile.avatar_url}
                      alt={label}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    initial
                  )}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-semibold text-sm text-slate-100 truncate">
                    {label}
                  </span>
                  <span className="text-[11px] text-slate-500 truncate">
                    @{label.toLowerCase().replace(/\s+/g, "")}
                  </span>
                </div>
              </Link>

              <div className="text-right text-xs sm:text-sm mt-1 sm:mt-0">
                <div className="font-mono text-yellow-400 text-base sm:text-lg">
                  {primaryRecordText}
                </div>
                <div className="text-[11px] sm:text-xs text-slate-400">
                  {isWeekView ? "Week" : "Season"} Win {primaryWinPctText}
                </div>
                <div className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                  {isWeekView ? (
                    <>
                      Season {seasonRecordText} · {seasonWinPctText} · Streak{" "}
                      {seasonStreakText}
                    </>
                  ) : (
                    <>
                      This week {weekRecordText} · Win {weekWinPctText}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] text-slate-500 mt-4">
        Week view grades records from this NFL week only. Season view combines
        all finished games across the year using your saved spread/ML at pick
        time.
      </p>
    </section>
  );
}