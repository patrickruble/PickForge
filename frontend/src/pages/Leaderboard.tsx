// src/pages/Leaderboard.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { getNflWeekNumber, currentNflWeekWindow } from "../hooks/useRemotePicks";

type League = "nfl" | "ncaaf";

type PickRow = {
  user_id: string;
  game_id: string;
  week: number;
  league: League;
};

type ProfileInfo = {
  username: string | null;
  avatar_url: string | null;
};

type LeaderItem = {
  user_id: string;
  picks: number;
  profile?: ProfileInfo;
};

const league: League = "nfl";

export default function Leaderboard() {
  const week = useMemo(() => getNflWeekNumber(new Date()), []);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [loading, setLoading] = useState(true);

  // user_id -> { username, avatar_url }
  const [profilesMap, setProfilesMap] = useState<Record<string, ProfileInfo>>(
    {}
  );

  // Nicely formatted week date range
  const weekWindow = useMemo(() => {
    const { weekStart, weekEnd } = currentNflWeekWindow(new Date());
    const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${weekStart.toLocaleDateString(undefined, fmt)} – ${weekEnd.toLocaleDateString(
      undefined,
      fmt
    )}`;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      const { data, error } = await supabase
        .from("picks")
        .select("user_id, game_id, week, league")
        .eq("league", league)
        .eq("week", week);

      if (cancelled) return;

      if (error) {
        console.error("[Leaderboard] load error:", error);
        setRows([]);
      } else {
        setRows((data ?? []) as PickRow[]);
      }

      setLoading(false);
    }

    load();

    // Realtime: refresh when any pick changes
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
    };
  }, [week]);

  // Aggregate in-memory: total picks per user for this week
  const aggregated: LeaderItem[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
    }

    const list: LeaderItem[] = [];
    counts.forEach((picks, user_id) => {
      list.push({
        user_id,
        picks,
        profile: profilesMap[user_id],
      });
    });

    list.sort((a, b) => b.picks - a.picks);
    return list.slice(0, 100);
  }, [rows, profilesMap]);

  // Resolve usernames + avatars from profiles
  useEffect(() => {
    const unknownIds = aggregated
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
  }, [aggregated, profilesMap]);

  const totalPlayers = useMemo(
    () => new Set(rows.map((r) => r.user_id)).size,
    [rows]
  );

  // -------- Loading / empty states --------

  if (loading && !rows.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-yellow-400 mb-2">Leaderboard</h1>
        <p className="text-sm text-slate-400 mb-4">
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

  if (!rows.length) {
    return (
      <div className="px-4 py-8 max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-yellow-400 mb-2">Leaderboard</h1>
        <p className="text-sm text-slate-400 mb-4">
          NFL Week {week} · {weekWindow}
        </p>
        <p className="text-slate-300">
          No picks have been made yet this week. Be the first to lock something in on
          Weekly Picks.
        </p>
      </div>
    );
  }

  // -------- Main UI --------

  return (
    <section className="px-4 py-6 max-w-4xl mx-auto">
      <header className="mb-4 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-yellow-400">Leaderboard</h1>
          <p className="text-sm text-slate-400">
            NFL Week {week} · {weekWindow}
          </p>
        </div>

        <div className="flex gap-4 text-xs sm:text-sm text-slate-400">
          <div>
            <span className="font-semibold text-slate-200">{totalPlayers}</span>{" "}
            players
          </div>
          <div>
            <span className="font-semibold text-slate-200">
              {rows.length}
            </span>{" "}
            total picks
          </div>
        </div>
      </header>

      {/* Desktop column headers */}
      <div className="hidden sm:grid grid-cols-[auto,1fr,auto] text-xs text-slate-400 px-3 pb-1">
        <span className="uppercase tracking-wide">Rank</span>
        <span className="uppercase tracking-wide">Player</span>
        <span className="text-right uppercase tracking-wide">Picks</span>
      </div>

      <ol className="space-y-2">
        {aggregated.map((item, idx) => {
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
              ? "border-yellow-400/80 shadow-yellow-400/20"
              : rank === 2
              ? "border-slate-400/70"
              : rank === 3
              ? "border-amber-600/70"
              : "border-slate-700/60";

          return (
            <li
              key={item.user_id}
              className={`rounded-2xl bg-slate-900/80 border ${rankStyles} px-3 py-2 sm:px-4 sm:py-3 flex items-center justify-between gap-3`}
            >
              {/* left side */}
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-7 text-xs font-semibold text-slate-400 text-right">
                  #{rank}
                </div>

                <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-100 border border-slate-700">
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
              </div>

              {/* right side */}
              <div className="text-right text-xs sm:text-sm">
                <span className="font-mono text-yellow-400 text-base sm:text-lg">
                  {item.picks}
                </span>
                <span className="ml-1 text-slate-400 text-[11px] sm:text-xs">
                  picks
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] text-slate-500 mt-4">
        Currently ranked by total picks submitted for this week. Future versions can
        track win rate and ROI once results are stored.
      </p>
    </section>
  );
}