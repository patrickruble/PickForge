// src/hooks/useAllUserStats.ts
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  moneylineMasteryDelta,
  MoneylineOutcome,
} from "../lib/MoneylineMastery";

type League = "nfl" | "ncaaf";

type PickRow = {
  user_id: string;
  game_id: string;
  league: League;
  week: number;
  side: "home" | "away";
  picked_price_type: "ml" | "spread" | null;
  picked_price: number | null;
  commence_at: string; // kickoff timestamp for ordering
};

type GameRow = {
  id: string;
  status: string | null;
  home_score: number | null;
  away_score: number | null;
};

type Grade = "pending" | "win" | "loss" | "push";

export type UserSeasonStats = {
  userId: string;
  totalPicks: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  currentStreakType: "W" | "L" | null;
  currentStreakLen: number;
  // Moneyline Mastery: cumulative score from moneyline-only picks
  moneylineMastery: number;
  // Moneyline-only record
  mlWins: number;
  mlLosses: number;
  mlPushes: number;
};

type StatsByUser = Record<string, UserSeasonStats>;

function safePct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

// Treat ONLY clearly-final states as final
function isGameFinal(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();

  // adjust these to match whatever values your games table actually uses
  return (
    s === "final" ||
    s === "finished" ||
    s === "complete" ||
    s === "completed" ||
    s === "closed" ||
    s === "fulltime"
  );
}

function gradePick(row: PickRow, game: GameRow | undefined | null): Grade {
  // Do NOT grade anything that isn't final yet
  if (!game || !isGameFinal(game.status)) return "pending";

  const home = game.home_score;
  const away = game.away_score;
  if (home == null || away == null) return "pending";

  const pickedScore = row.side === "home" ? home : away;
  const otherScore = row.side === "home" ? away : home;

  // Moneyline or missing spread → straight up
  if (row.picked_price_type === "ml" || row.picked_price == null) {
    if (pickedScore > otherScore) return "win";
    if (pickedScore < otherScore) return "loss";
    return "push";
  }

  // Against the spread
  const spread = row.picked_price;
  const spreadDiff = pickedScore + spread - otherScore;
  if (spreadDiff > 0) return "win";
  if (spreadDiff < 0) return "loss";
  return "push";
}

export function useAllUserStats(): {
  statsByUser: StatsByUser;
  loading: boolean;
  error: string | null;
} {
  const [statsByUser, setStatsByUser] = useState<StatsByUser>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // 1) Fetch all NFL picks, including commence_at so we can sort by time
        const { data: picksRaw, error: picksError } = await supabase
          .from("picks")
          .select(
            "user_id, game_id, league, week, side, picked_price_type, picked_price, commence_at"
          )
          .eq("league", "nfl");

        if (picksError) throw picksError;

        let picks = (picksRaw ?? []) as PickRow[];

        if (!picks.length) {
          if (!cancelled) {
            setStatsByUser({});
            setLoading(false);
          }
          return;
        }

        // 2) Sort picks chronologically by kickoff time
        picks = picks.slice().sort((a, b) => {
          const ta = new Date(a.commence_at).getTime();
          const tb = new Date(b.commence_at).getTime();
          return ta - tb;
        });

        // 3) Fetch games used in those picks
        const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));

        const { data: gamesRaw, error: gamesError } = await supabase
          .from("games")
          .select("id, status, home_score, away_score")
          .in("id", gameIds);

        if (gamesError) throw gamesError;

        const games = (gamesRaw ?? []) as GameRow[];
        const gameMap = new Map<string, GameRow>();
        for (const g of games) gameMap.set(g.id, g);

        // 4) Aggregate by user in chronological order
        const perUserResults = new Map<string, ("W" | "L" | "P")[]>();
        const byUser: StatsByUser = {};

        for (const p of picks) {
          const game = gameMap.get(p.game_id);
          const grade = gradePick(p, game);

          // only FINAL games reach here as win/loss/push
          if (grade === "pending") continue;

          if (!byUser[p.user_id]) {
            byUser[p.user_id] = {
              userId: p.user_id,
              totalPicks: 0,
              wins: 0,
              losses: 0,
              pushes: 0,
              winRate: 0,
              currentStreakType: null,
              currentStreakLen: 0,
              moneylineMastery: 0,
              mlWins: 0,
              mlLosses: 0,
              mlPushes: 0,
            };
          }

          const s = byUser[p.user_id];

          if (grade === "win") {
            s.wins++;
            perUserResults.set(p.user_id, [
              ...(perUserResults.get(p.user_id) ?? []),
              "W",
            ]);
          } else if (grade === "loss") {
            s.losses++;
            perUserResults.set(p.user_id, [
              ...(perUserResults.get(p.user_id) ?? []),
              "L",
            ]);
          } else if (grade === "push") {
            s.pushes++;
            perUserResults.set(p.user_id, [
              ...(perUserResults.get(p.user_id) ?? []),
              "P",
            ]);
          }

          s.totalPicks = s.wins + s.losses + s.pushes;
          s.winRate = safePct(s.wins, s.wins + s.losses) * 100;

          // Moneyline Mastery accumulation (moneyline-only picks)
          if (p.picked_price_type === "ml" && p.picked_price != null) {
            const outcome = grade as MoneylineOutcome;

            // Update moneyline-only record
            if (grade === "win") {
              s.mlWins++;
            } else if (grade === "loss") {
              s.mlLosses++;
            } else if (grade === "push") {
              s.mlPushes++;
            }

            // Accumulate mastery score based on captured odds and outcome
            const delta = moneylineMasteryDelta(p.picked_price, outcome);
            s.moneylineMastery += delta;
          }
        }

        // 5) Compute current streak per user from most recent graded pick backwards
        for (const [userId, resArr] of perUserResults.entries()) {
          let type: "W" | "L" | null = null;
          let len = 0;

          for (let i = resArr.length - 1; i >= 0; i--) {
            const r = resArr[i];
            if (r === "P") continue; // pushes don't affect streak

            if (!type) {
              type = r;
              len = 1;
            } else if (r === type) {
              len++;
            } else {
              // hit a different result → streak ends
              break;
            }
          }

          if (byUser[userId]) {
            byUser[userId].currentStreakType = type;
            byUser[userId].currentStreakLen = len;
          }
        }

        if (cancelled) return;
        setStatsByUser(byUser);
        setLoading(false);
      } catch (e: any) {
        console.error("[useAllUserStats] error:", e);
        if (cancelled) return;
        setError(e.message ?? "Failed to load stats");
        setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { statsByUser, loading, error };
}