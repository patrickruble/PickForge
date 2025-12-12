// src/pages/Leaderboard.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAllUserStats } from "../hooks/useAllUserStats";
import {
  getNflWeekNumber,
  currentNflWeekWindow,
} from "../hooks/useRemotePicks";
import { usePageSeo } from "../hooks/usePageSeo";

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
  contest_type: "pickem" | "mm" | null;
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
  winPct: number; // 0–1 fraction
  profile?: ProfileInfo;
  streakScore?: number;
  isCreator?: boolean;
};

type Grade = "pending" | "win" | "loss" | "push";

const league: League = "nfl";
const MIN_WEEK = 1;
const MAX_WEEK = 18;
const CREATOR_USERNAME = "ForgeMaster";

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
  const [searchParams] = useSearchParams();
  const isShareMode = searchParams.get("share") === "1";

  const currentWeek = useMemo(() => getNflWeekNumber(new Date()), []);

  const [selectedWeek, setSelectedWeek] = useState(() => {
    const fromUrl = searchParams.get("week");
    const parsed = fromUrl ? parseInt(fromUrl, 10) : NaN;
    if (!Number.isNaN(parsed) && parsed >= MIN_WEEK && parsed <= MAX_WEEK) {
      return parsed;
    }
    return currentWeek;
  });

  const initialViewParam = searchParams.get("view");
  const initialMetricParam = searchParams.get("metric");

  const [viewMode, setViewMode] = useState<"week" | "season">(
    initialViewParam === "season" ? "season" : "week"
  );

  const [metricMode, setMetricMode] = useState<"standard" | "mm">(
    initialMetricParam === "mm" ? "mm" : "standard"
  );

  const isCurrentWeek = selectedWeek === currentWeek;

  // SEO for leaderboard page
  usePageSeo({
    title: `PickForge — NFL Week ${selectedWeek} Pick’em Leaderboard & Season Standings`,
    description:
      "Check the PickForge NFL pick’em leaderboard for this week and the full season. Track wins, losses, pushes, and win rate for every player.",
  });

  const [rows, setRows] = useState<PickWithGame[]>([]);
  const [loading, setLoading] = useState(true);

  const [profilesMap, setProfilesMap] = useState<Record<string, ProfileInfo>>(
    {}
  );

  const [copyStatus, setCopyStatus] = useState<"idle" | "share" | "invite">(
    "idle"
  );


  // Search term for players
  const [searchTerm, setSearchTerm] = useState("");

  // Season-long stats for each user
  const { statsByUser, loading: statsLoading } = useAllUserStats();

  // Only compute a real date window for the actual current week
  const weekWindow = useMemo(() => {
    if (!isCurrentWeek) return null;
    const { weekStart, weekEnd } = currentNflWeekWindow(new Date());
    const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${weekStart.toLocaleDateString(
      undefined,
      fmt
    )} – ${weekEnd.toLocaleDateString(undefined, fmt)}`;
  }, [isCurrentWeek]);

  // Load picks + games for the selected week
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      // Picks for selected week
      const { data: pickData, error: pickError } = await supabase
        .from("picks")
        .select(
          "user_id, game_id, week, league, side, picked_price_type, picked_price, contest_type"
        )
        .eq("league", league)
        .eq("week", selectedWeek);

      if (pickError) {
        console.error("[Leaderboard] picks load error:", pickError);
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
        return;
      }

      const picks = (pickData ?? []) as PickRow[];

      // Games for selected week
      const { data: gameData, error: gameError } = await supabase
        .from("games")
        .select("id, status, home_score, away_score, week, league")
        .eq("league", league)
        .eq("week", selectedWeek);

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
      .channel(`leaderboard-${league}-${selectedWeek}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "picks" },
        () => load()
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [selectedWeek]);

  // Weekly aggregated leaderboard (graded picks only) — respects metric toggle
  const weekAggregated: LeaderItem[] = useMemo(() => {
    const stats = new Map<string, LeaderItem>();

    const isMM = metricMode === "mm";

    for (const r of rows) {
      // Only count picks that match the current metric mode
      if (isMM) {
        if (r.contest_type !== "mm") continue;
        if (r.picked_price_type !== "ml") continue;
      } else {
        if (r.contest_type !== "pickem") continue;
        if (r.picked_price_type !== "spread") continue;
      }

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
      s.winPct = s.total > 0 ? s.wins / s.total : 0;
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
  }, [rows, profilesMap, metricMode]);

  // Season aggregated leaderboard from useAllUserStats
  const seasonAggregated: LeaderItem[] = useMemo(() => {
    const list: LeaderItem[] = [];

    Object.entries(statsByUser).forEach(([user_id, s]) => {
      if (s.totalPicks === 0) return;

      const streakScore =
        s && s.currentStreakType === "W" && typeof s.currentStreakLen === "number"
          ? s.currentStreakLen
          : 0;

      const profile = profilesMap[user_id];
      const isCreator =
        !!profile &&
        typeof profile.username === "string" &&
        profile.username.trim() === CREATOR_USERNAME;

      list.push({
        user_id,
        wins: s.wins,
        losses: s.losses,
        pushes: s.pushes,
        total: s.totalPicks,
        winPct: s.winRate / 100, // convert percent to fraction
        profile: profilesMap[user_id],
        streakScore,
        isCreator,
      });
    });

    list.sort((a, b) => {
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      if (b.wins !== a.wins) return b.wins - a.wins;

      const sa = a.streakScore ?? 0;
      const sb = b.streakScore ?? 0;
      if (sb !== sa) return sb - sa;

      const aCreator = !!a.isCreator;
      const bCreator = !!b.isCreator;
      if (aCreator && !bCreator) return -1;
      if (!aCreator && bCreator) return 1;

      return 0;
    });

    return list.slice(0, 100);
  }, [statsByUser, profilesMap]);

  // All users who have relevant picks for the selected week (spread for Pick'em, ML for MM)
  const weekParticipants: string[] = useMemo(() => {
    const set = new Set<string>();

    for (const r of rows) {
      // For week view, respect the metric toggle:
      //  - Pick'em: only consider spread picks
      //  - MM: only consider moneyline picks
      if (metricMode === "mm") {
        if (r.picked_price_type !== "ml") continue;
      } else {
        // Pick'em mode
        if (r.picked_price_type !== "spread") continue;
      }

      set.add(r.user_id);
    }

    return Array.from(set);
  }, [rows, metricMode]);

  // Week view: show all players who picked this week, ordered by season standings
  const weekViewAggregated: LeaderItem[] = useMemo(() => {
    if (!weekParticipants.length) return [];

    const participantSet = new Set(weekParticipants);
    const list: LeaderItem[] = [];

    // First: players who have season stats, in season order
    for (const item of seasonAggregated) {
      if (participantSet.has(item.user_id)) {
        list.push(item);
      }
    }

    // Then: players who picked this week but have no graded season picks yet
    const alreadyIncluded = new Set(list.map((i) => i.user_id));
    for (const user_id of weekParticipants) {
      if (!alreadyIncluded.has(user_id)) {
        list.push({
          user_id,
          wins: 0,
          losses: 0,
          pushes: 0,
          total: 0,
          winPct: 0,
          profile: profilesMap[user_id],
        });
      }
    }

    return list;
  }, [weekParticipants, seasonAggregated, profilesMap]);

  // For loading profiles, consider week users, season users, and anyone with picks this week
  const allAggregatedForProfiles: LeaderItem[] = useMemo(() => {
    const map = new Map<string, LeaderItem>();

    // Anyone with weekly graded stats
    for (const item of weekAggregated) {
      map.set(item.user_id, item);
    }

    // Anyone with season stats
    for (const item of seasonAggregated) {
      if (!map.has(item.user_id)) {
        map.set(item.user_id, item);
      }
    }

    // Anyone who has any pick this week (even if all pending)
    for (const r of rows) {
      if (!map.has(r.user_id)) {
        map.set(r.user_id, {
          user_id: r.user_id,
          wins: 0,
          losses: 0,
          pushes: 0,
          total: 0,
          winPct: 0,
          profile: profilesMap[r.user_id],
        });
      }
    }

    return Array.from(map.values());
  }, [weekAggregated, seasonAggregated, rows, profilesMap]);

  // Load profiles for any user ids we do not know yet
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
        setProfilesMap((prev) => {
          const next: Record<string, ProfileInfo> = { ...prev };
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
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [allAggregatedForProfiles, profilesMap]);

  const activeAggregated: LeaderItem[] = useMemo(() => {
    if (viewMode === "week") return weekViewAggregated;

    // Season view
    let base = [...seasonAggregated];

    // In MM mode, only include users who have actually played Moneyline Mastery
    if (metricMode === "mm") {
      base = base.filter((item) => {
        const s = statsByUser[item.user_id];
        if (!s) return false;

        if (typeof s.moneylineMastery === "number") {
          return true;
        }

        const mmCount =
          typeof (s as any).moneylinePicks === "number"
            ? (s as any).moneylinePicks
            : typeof (s as any).mmPicks === "number"
            ? (s as any).mmPicks
            : undefined;

        return typeof mmCount === "number" && mmCount > 0;
      });

      // Sort MM by mastery score, then by standard season standings plus streak/creator tiebreaks
      base.sort((a, b) => {
        const sa = statsByUser[a.user_id];
        const sb = statsByUser[b.user_id];

        const ma =
          sa && typeof sa.moneylineMastery === "number"
            ? sa.moneylineMastery
            : -Infinity;
        const mb =
          sb && typeof sb.moneylineMastery === "number"
            ? sb.moneylineMastery
            : -Infinity;

        if (mb !== ma) return mb - ma;

        // fall back to regular season ordering: win%, wins, streak, creator
        if (b.winPct !== a.winPct) return b.winPct - a.winPct;
        if (b.wins !== a.wins) return b.wins - a.wins;

        const aStreak =
          sa && sa.currentStreakType === "W" && typeof sa.currentStreakLen === "number"
            ? sa.currentStreakLen
            : 0;
        const bStreak =
          sb && sb.currentStreakType === "W" && typeof sb.currentStreakLen === "number"
            ? sb.currentStreakLen
            : 0;
        if (bStreak !== aStreak) return bStreak - aStreak;

        const aProfile = profilesMap[a.user_id];
        const bProfile = profilesMap[b.user_id];
        const aCreator =
          !!aProfile &&
          typeof aProfile.username === "string" &&
          aProfile.username.trim() === CREATOR_USERNAME;
        const bCreator =
          !!bProfile &&
          typeof bProfile.username === "string" &&
          bProfile.username.trim() === CREATOR_USERNAME;

        if (aCreator && !bCreator) return -1;
        if (!aCreator && bCreator) return 1;

        return 0;
      });
    } else {
      // Standard Pick'em mode: use seasonAggregated ordering (already sorted with streak + creator tiebreaks)
      return base;
    }

    return base;
  }, [viewMode, weekViewAggregated, seasonAggregated, metricMode, statsByUser, profilesMap]);

  // Tie-aware rank map (same stats share rank; next rank skips)
  const rankMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!activeAggregated.length) return map;

    let currentRank = 0;
    let itemsSeen = 0;
    let prevKey: string | null = null;

    for (const item of activeAggregated) {
      const key = `${item.winPct}|${item.wins}|${item.losses}|${item.pushes}`;

      if (prevKey === null) {
        currentRank = 1;
      } else if (key !== prevKey) {
        currentRank = itemsSeen + 1;
      }

      map.set(item.user_id, currentRank);
      itemsSeen += 1;
      prevKey = key;
    }

    return map;
  }, [activeAggregated]);

  // Filtered list based on search term
  const filteredAggregated: LeaderItem[] = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return activeAggregated;

    return activeAggregated.filter((item) => {
      const profile = item.profile;
      const username = profile?.username ?? "";
      const baseLabel =
        username && username.trim().length > 0
          ? username
          : `user_${item.user_id.slice(0, 6)}`;
      const handle = baseLabel.toLowerCase().replace(/\s+/g, "");

      return (
        baseLabel.toLowerCase().includes(term) || handle.includes(term)
      );
    });
  }, [activeAggregated, searchTerm]);

  const totalPlayers = useMemo(
    () => new Set(activeAggregated.map((r) => r.user_id)).size,
    [activeAggregated]
  );

  const isWeekView = viewMode === "week";

  const handleCopyShareLink = () => {
    if (typeof window === "undefined") return;

    try {
      const url = new URL(window.location.href);
      url.searchParams.set("week", String(selectedWeek));
      url.searchParams.set("view", viewMode);
      url.searchParams.set("metric", metricMode);
      url.searchParams.set("share", "1");

      const text = url.toString();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      setCopyStatus("share");
      window.setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (err) {
      console.error("[Leaderboard] failed to copy share link", err);
    }
  };

  const handleCopyInviteLink = () => {
    if (typeof window === "undefined") return;

    try {
      const url = new URL(window.location.origin);
      url.pathname = "/leaderboard";
      url.searchParams.set("share", "1");

      const text = url.toString();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }

      setCopyStatus("invite");
      window.setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (err) {
      console.error("[Leaderboard] failed to copy invite link", err);
    }
  };

  // Loading state for week view
  if (isWeekView && loading && !rows.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto font-sans">
        <h1 className="font-display text-3xl sm:text-4xl tracking-[0.18em] uppercase text-yellow-400 mb-1 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Leaderboard
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mb-4">
          NFL Week {selectedWeek}
          {weekWindow ? ` · ${weekWindow}` : ""}
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

  // Only show full-page empty state if there is NO season data either
  if (!activeAggregated.length && !seasonAggregated.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto font-sans">
        <h1 className="font-display text-3xl sm:text-4xl tracking-[0.18em] uppercase text-yellow-400 mb-1 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Leaderboard
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mb-4">
          {isWeekView
            ? `NFL Week ${selectedWeek}${
                weekWindow ? ` · ${weekWindow}` : ""
              }`
            : "Season Leaderboard"}
        </p>
        <p className="text-slate-300 text-sm">
          {isWeekView
            ? "No games have finished yet this week, so records have not been graded."
            : statsLoading
            ? "Loading season stats…"
            : "No finished games yet this season, so season records are not available."}
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
              ? `NFL Week ${selectedWeek}${
                  weekWindow ? ` · ${weekWindow}` : ""
                }`
              : "Season results across all finished weeks"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] sm:text-xs text-slate-300 items-center justify-end">
          <div className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80">
            <span className="font-semibold text-slate-100">
              {totalPlayers}
            </span>{" "}
            players
          </div>

          {/* Week selector – always usable */}
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full overflow-hidden">
            <button
              type="button"
              onClick={() =>
                setSelectedWeek((w) => Math.max(MIN_WEEK, w - 1))
              }
              disabled={selectedWeek <= MIN_WEEK}
              className="px-2 py-1 text-[11px] sm:text-xs text-slate-300 disabled:opacity-40 hover:text-slate-100"
            >
              ◀
            </button>
            <span className="px-2 py-1 text-[11px] sm:text-xs text-slate-200">
              Week {selectedWeek}
            </span>
            <button
              type="button"
              onClick={() =>
                setSelectedWeek((w) => Math.min(MAX_WEEK, w + 1))
              }
              disabled={selectedWeek >= MAX_WEEK}
              className="px-2 py-1 text-[11px] sm:text-xs text-slate-300 disabled:opacity-40 hover:text-slate-100"
            >
              ▶
            </button>
          </div>

          <button
            type="button"
            onClick={() => setSelectedWeek(currentWeek)}
            disabled={selectedWeek === currentWeek}
            className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 text-[11px] sm:text-xs text-slate-300 hover:text-slate-100 disabled:opacity-40"
          >
            This week
          </button>

          {/* View toggle */}
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

          {/* Metric toggle – always visible; clicking also switches to Season view */}
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
            <button
              onClick={() => {
                setViewMode("season");
                setMetricMode("standard");
              }}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                metricMode === "standard"
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              Pick&apos;em
            </button>
            <button
              onClick={() => {
                setViewMode("season");
                setMetricMode("mm");
              }}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                metricMode === "mm"
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              MM
            </button>
          </div>

          {/* Share / Invite / Search controls */}
          {!isShareMode && (
            <>
              <button
                type="button"
                onClick={handleCopyShareLink}
                className="px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 text-[11px] sm:text-xs text-slate-300 hover:text-slate-100"
              >
                Share leaderboard
              </button>
              <button
                type="button"
                onClick={handleCopyInviteLink}
                className="px-2.5 py-1 rounded-full bg-emerald-900/40 border border-emerald-500/60 text-[11px] sm:text-xs text-emerald-100 hover:text-emerald-50"
              >
                Invite friends
              </button>
            </>
          )}
          {isShareMode && (
            <div className="px-2.5 py-1 rounded-full bg-emerald-900/40 border border-emerald-500/60 text-[11px] sm:text-xs text-emerald-200">
              Share view
            </div>
          )}

          {/* Search input (hidden in share mode for a cleaner card) */}
          {!isShareMode && (
            <div className="w-full sm:w-44 md:w-56">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search players"
                className="w-full rounded-full bg-slate-900/80 border border-slate-700/80 px-3 py-1 text-[11px] sm:text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-yellow-400"
              />
            </div>
          )}

          {copyStatus !== "idle" && (
            <div className="text-[10px] sm:text-[11px] text-emerald-300">
              {copyStatus === "share"
                ? "Leaderboard link copied!"
                : "Invite link copied!"}
            </div>
          )}
        </div>
      </header>

      {/* Hint when this week has no graded games yet */}
      {isWeekView && !weekAggregated.length && seasonAggregated.length > 0 && (
        <p className="text-[11px] sm:text-xs text-slate-500 mb-2">
          No graded games have finished yet for Week {selectedWeek}. Players
          below are ordered by their season standings. Week records will update
          once games go final.
        </p>
      )}

      <div className="hidden sm:grid grid-cols-[auto,1fr,auto] text-[11px] uppercase tracking-wide text-slate-500 px-3 pb-1">
        <span>Rank</span>
        <span>Player</span>
        <span className="text-right">
          {isWeekView ? "Week Record" : "Season Record"}
        </span>
      </div>

      <ol className="space-y-2 sm:space-y-3">
        {filteredAggregated.map((item) => {
          const profile = item.profile;
          const username = profile?.username ?? null;
          const label =
            username && username.trim().length > 0
              ? username
              : `user_${item.user_id.slice(0, 6)}`;

          const initial = (label[0] ?? "?").toUpperCase();
          const slugForUser =
            username && username.trim().length > 0
              ? username.trim()
              : item.user_id;
          const rank = rankMap.get(item.user_id) ?? 0;

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

          const moneylineMasteryText =
            seasonStats && typeof seasonStats.moneylineMastery === "number"
              ? `${seasonStats.moneylineMastery >= 0 ? "+" : ""}${seasonStats.moneylineMastery.toFixed(
                  0
                )}`
              : "—";

          // Primary display based on view / metric
          const isSeasonMM = !isWeekView && metricMode === "mm";

          const primaryRecordText = isSeasonMM
            ? moneylineMasteryText
            : isWeekView
            ? weekRecordText
            : seasonRecordText;

          const primaryWinPctText = isSeasonMM
            ? ""
            : isWeekView
            ? weekWinPctText
            : seasonWinPctText;

          return (
            <li
              key={item.user_id}
              className={`rounded-2xl bg-slate-900/80 border ${rankStyles} px-3 py-2 sm:px-4 sm:py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3`}
            >
              {/* Clickable player area */}
              <Link
                to={`/u/${slugForUser}`}
                className="flex items-center gap-3 min-w-0 flex-shrink-0 hover:opacity-90 transition"
              >
                <div className="w-7 text-[11px] font-semibold text-slate-500 text-right">
                  #{rank || "?"}
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
                  {isSeasonMM
                    ? "Moneyline Mastery Score"
                    : `${isWeekView ? "Week" : "Season"} Win ${primaryWinPctText}`}
                </div>
                {!isSeasonMM && (
                  <div className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                    {isWeekView ? (
                      <>
                        Season {seasonRecordText} · {seasonWinPctText} · Streak {" "}
                        {seasonStreakText}
                      </>
                    ) : (
                      <>
                        This week {weekRecordText} · Win {weekWinPctText} · Streak {" "}
                        {seasonStreakText}
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] text-slate-500 mt-4">
        Week view grades records for the selected NFL week only. Season view
        combines all finished games across the year using your saved spread or
        moneyline at pick time.
      </p>
    </section>
  );
}