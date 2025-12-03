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

type ProfileInfo = {
  username: string | null;
  avatar_url: string | null;
};

type LeaderItem = {
  user_id: string;
  picks: number;
  profile?: ProfileInfo;
};

export default function Leaderboard() {
  const league: League = "nfl";
  const week = useMemo(() => getNflWeekNumber(new Date()), []);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [loading, setLoading] = useState(true);

  // user_id -> { username, avatar_url }
  const [profilesMap, setProfilesMap] = useState<Record<string, ProfileInfo>>(
    {}
  );

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
    counts.forEach((picks, user_id) => {
      list.push({
        user_id,
        picks,
        profile: profilesMap[user_id],
      });
    });

    list.sort((a, b) => b.picks - a.picks);
    return list.slice(0, 100); // cap to top 100 for safety
  }, [rows, profilesMap]);

  // Resolve usernames + avatars from profiles
  useEffect(() => {
    // Collect user_ids that we don't have profile info for yet
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

  if (loading) {
    return <div className="p-6 text-slate-300">Loading leaderboard…</div>;
  }

  if (!rows.length) {
    return (
      <div className="p-6 text-slate-300">
        <h1 className="text-2xl font-bold text-yellow-400 mb-3">
          Leaderboard
        </h1>
        <p>No picks have been made yet for Week {week}.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-yellow-400 mb-4">
        Leaderboard — Week {week}
      </h1>

      <ol className="space-y-2">
        {aggregated.map((item, idx) => {
          const profile = item.profile;
          const username = profile?.username ?? null;
          const label =
            username && username.trim().length > 0
              ? username
              : `user_${item.user_id.slice(0, 6)}`;

          const initial = (username?.[0] ?? "?").toUpperCase();

          return (
            <li
              key={item.user_id}
              className="rounded-xl p-3 bg-slate-800/70 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm w-6 text-right text-slate-400">
                  #{idx + 1}
                </span>

                {/* Avatar + name */}
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-100">
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
                  <span className="font-semibold">{label}</span>
                </div>
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
        * Currently ranked by total picks this week. We can later rank by win
        rate, units won, or ROI once outcomes are tracked.
      </p>
    </div>
  );
}