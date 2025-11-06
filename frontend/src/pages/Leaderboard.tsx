import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { getNflWeekNumber } from "../hooks/useRemotePicks";

type League = "nfl" | "ncaaf";

type PickRow = {
  user_id: string;
  game_id: string;
  week: number;
  league: League;
};

type LeaderItem = {
  user_id: string;
  username?: string | null;
  picks: number;
};

export default function Leaderboard() {
  const league: League = "nfl";
  const week = useMemo(() => getNflWeekNumber(new Date()), []);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [names, setNames] = useState<Record<string, string | null>>({}); // user_id → username (if available)

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      // Pull all picks for this league/week (no need to be signed-in)
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

    // Realtime: refresh when any pick changes for this week
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
  }, [league, week]);

  // Aggregate in-memory: total picks per user for this week
  const aggregated: LeaderItem[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
    }
    const list: LeaderItem[] = [];
    counts.forEach((picks, user_id) => list.push({ user_id, picks, username: names[user_id] }));
    list.sort((a, b) => b.picks - a.picks);
    return list.slice(0, 100); // cap to top 100 for safety
  }, [rows, names]);

  // Optional: try to resolve usernames from a `profiles` table if it exists
  useEffect(() => {
    // Collect user_ids that we don't have names for yet
    const unknownIds = aggregated
      .filter((i) => names[i.user_id] === undefined)
      .map((i) => i.user_id);

    if (!unknownIds.length) return;

    let cancelled = false;

    (async () => {
      // If you created a `profiles` table: id (uuid PK) references auth.users(id), username text
      // This query will work only if that table exists and RLS allows anon read (or viewer is authed).
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username")
        .in("id", unknownIds);

      if (cancelled) return;

      if (!error && data) {
        const next = { ...names };
        for (const row of data as { id: string; username: string | null }[]) {
          next[row.id] = row.username ?? null;
        }
        setNames(next);
      }
    })();

    return () => { cancelled = true; };
  }, [aggregated]); // intentionally not depending on names to avoid loops

  if (loading) {
    return <div className="p-6 text-slate-300">Loading leaderboard…</div>;
  }

  if (!rows.length) {
    return (
      <div className="p-6 text-slate-300">
        <h1 className="text-2xl font-bold text-yellow-400 mb-3">Leaderboard</h1>
        <p>No picks have been made yet for Week {week}.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-yellow-400 mb-4">Leaderboard — Week {week}</h1>

      <ol className="space-y-2">
        {aggregated.map((item, idx) => {
          const label =
            item.username && item.username.trim().length > 0
              ? item.username
              : `user_${item.user_id.slice(0, 6)}`;

          return (
            <li
              key={item.user_id}
              className="rounded-xl p-3 bg-slate-800/70 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm w-6 text-right text-slate-400">#{idx + 1}</span>
                <span className="font-semibold">{label}</span>
              </div>
              <div className="text-sm">
                <span className="text-yellow-400 font-mono">{item.picks}</span>{" "}
                <span className="text-slate-400">picks</span>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-xs text-slate-500 mt-4">
        * Currently ranked by total picks this week. Add a results table later to rank by correct picks / ROI.
      </p>
    </div>
  );
}