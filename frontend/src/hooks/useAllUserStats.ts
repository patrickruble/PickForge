// src/hooks/useAllUserStats.ts
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type PickRow = {
  id: string;
  user_id: string;
  league: string;
  week: number;
  game_id: string;
  side: string; // "home" | "away"
};

type GameRow = {
  id: string;
  week: number;
  home_score: number | null;
  away_score: number | null;
  status: string;
};

export type UserSeasonStats = {
  userId: string;
  totalPicks: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  currentStreakType: "W" | "L" | null;
  currentStreakLen: number;
};

type StatsByUserId = Record<string, UserSeasonStats>;

function safePct(n: number, d: number): number {
  if (!d) return 0;
  return n / d;
}

export function useAllUserStats() {
  const [statsByUser, setStatsByUser] = useState<StatsByUserId>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // 1) Fetch ALL picks
        const { data: picksRaw, error: picksError } = await supabase
          .from("picks")
          .select("id,user_id,league,week,game_id,side");

        if (picksError) throw picksError;

        const picks = (picksRaw ?? []) as PickRow[];

        if (picks.length === 0) {
          if (!mounted) return;
          setStatsByUser({});
          setLoading(false);
          return;
        }

        // 2) Fetch ALL games used by those picks
        const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));

        const { data: gamesRaw, error: gamesError } = await supabase
          .from("games")
          .select("id,week,home_score,away_score,status")
          .in("id", gameIds);

        if (gamesError) throw gamesError;

        const games = (gamesRaw ?? []) as GameRow[];

        const gameMap = new Map<string, GameRow>();
        for (const g of games) {
          gameMap.set(g.id, g);
        }

        // 3) Group picks by user
        const picksByUser = new Map<string, PickRow[]>();
        for (const p of picks) {
          const arr = picksByUser.get(p.user_id) ?? [];
          arr.push(p);
          picksByUser.set(p.user_id, arr);
        }

        const result: StatsByUserId = {};

        // 4) Compute stats per user
        for (const [userId, userPicks] of picksByUser.entries()) {
          let wins = 0;
          let losses = 0;
          let pushes = 0;

          type Result = "W" | "L" | "P";
          const chronologicalResults: { week: number; res: Result }[] = [];

          for (const p of userPicks) {
            const g = gameMap.get(p.game_id);
            if (!g) continue;

            const { home_score, away_score, status } = g;

            // only count finished games with scores
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
            chronologicalResults.push({ week: wk, res });
          }

          const totalPicks = wins + losses + pushes;
          const winRate = safePct(wins, wins + losses) * 100;

          // streaks (pushes don't break streak)
          let currentType: "W" | "L" | null = null;
          let currentLen = 0;

          // sort by week so streak is chronological
          chronologicalResults.sort((a, b) => a.week - b.week);

          for (const { res } of chronologicalResults) {
            if (res === "P") continue;
            if (!currentType || currentType !== res) {
              currentType = res;
              currentLen = 1;
            } else {
              currentLen++;
            }
          }

          result[userId] = {
            userId,
            totalPicks,
            wins,
            losses,
            pushes,
            winRate,
            currentStreakType: currentType,
            currentStreakLen: currentLen,
          };
        }

        if (!mounted) return;
        setStatsByUser(result);
        setLoading(false);
      } catch (e: any) {
        console.error("[useAllUserStats] error:", e);
        if (!mounted) return;
        setError(e.message ?? "Failed to load stats");
        setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  return { statsByUser, loading, error };
}