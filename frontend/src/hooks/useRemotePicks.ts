import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";

type PickSide = "home" | "away";
export interface PicksMap {
  [gameId: string]: { side: PickSide } | undefined;
}

type Game = {
  id: string;
  home: string;
  away: string;
  commenceTime: string; // ISO
  spreadHome?: number | null;
  spreadAway?: number | null;
  moneyline?: Record<string, number | null | undefined>;
};

const MS_DAY = 24 * 60 * 60 * 1000;
const startOfDayLocal = (d: Date) => new Date(d.setHours(0, 0, 0, 0));
export function currentNflWeekWindow(now = new Date()) {
  const today = startOfDayLocal(new Date(now));
  const dow = today.getDay();
  const daysSinceTue = (dow - 2 + 7) % 7;
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - daysSinceTue);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  return { weekStart, weekEnd };
}
export function getNflWeekNumber(dt: Date) {
  const baseStr = (import.meta.env.VITE_NFL_SEASON_START_TUE ?? "").trim();
  const base = baseStr ? new Date(baseStr + "T00:00:00") : new Date("2024-09-03T00:00:00");
  const weeks = Math.floor((dt.getTime() - base.getTime()) / (7 * MS_DAY)) + 1;
  return Math.max(1, Math.min(22, weeks));
}

function useSession() {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;
      setUserId(session?.user?.id ?? null);
      setReady(true);
    }
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      if (!mounted) return;
      setUserId(s?.user?.id ?? null);
      setReady(true);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { ready, userId };
}

export function useRemotePicks() {
  const { ready, userId } = useSession();
  const [picks, setPicks] = useState<PicksMap>({});
  const [mmPicks, setMmPicks] = useState<PicksMap>({});
  const [loading, setLoading] = useState(true);

  const count = useMemo(() => Object.keys(picks).length, [picks]);
  const mmCount = useMemo(() => Object.keys(mmPicks).length, [mmPicks]);

  const isLocked = useCallback((commenceIso: string, nowMs?: number) => {
    const now = nowMs ? new Date(nowMs) : new Date();
    return now >= new Date(commenceIso);
  }, []);

  // Load picks for current week when authenticated
  useEffect(() => {
    if (!ready) return;
    if (!userId) { setPicks({}); setMmPicks({}); setLoading(false); return; }

    const week = getNflWeekNumber(new Date());
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("picks")
          .select("game_id, side, contest_type")
          .eq("user_id", userId)
          .eq("league", "nfl")
          .eq("week", week);

        if (error) throw error;

        if (!cancelled) {
          const pickemMap: PicksMap = {};
          const mmMap: PicksMap = {};
          for (const row of data ?? []) {
            const contest = (row as any).contest_type as "pickem" | "mm" | null;
            const side = (row as any).side as PickSide;
            if (!contest || !side) continue;
            if (contest === "pickem") pickemMap[(row as any).game_id] = { side };
            else if (contest === "mm") mmMap[(row as any).game_id] = { side };
          }
          setPicks(pickemMap);
          setMmPicks(mmMap);
        }
      } catch (e) {
        console.error("Load picks error:", e);
        if (!cancelled) {
          setPicks({});
          setMmPicks({});
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    const channel = supabase
      .channel(`picks-self-${userId}-nfl-${week}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "picks", filter: `user_id=eq.${userId}` },
        () => load()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ready, userId]);

  const togglePick = useCallback(
    async (
      game: Game,
      side: PickSide,
      opts?: {
        priceType?: "spread" | "ml" | null;
        price?: number | null;
        contestType?: "pickem" | "mm";
      }
    ) => {
      if (!userId) { alert("Please log in to make picks."); return; }

      const gameId = game.id;
      const kickoff = new Date(game.commenceTime);
      const week = getNflWeekNumber(kickoff);
      const contestType: "pickem" | "mm" = opts?.contestType ?? "pickem";
      const currentMap = contestType === "mm" ? mmPicks : picks;
      const already = currentMap[gameId]?.side === side;

      const spreadHome = game.spreadHome ?? null;
      const spreadAway = game.spreadAway ?? null;
      const mlHome = game.moneyline?.[game.home] ?? null;
      const mlAway = game.moneyline?.[game.away] ?? null;

      // Start with any explicit values passed from the caller (e.g. Moneyline Mastery mode)
      let picked_price_type: "spread" | "ml" | null = opts?.priceType ?? null;
      let picked_price: number | null = opts?.price ?? null;

      // If the caller didn't supply explicit pricing, fall back to legacy auto-detection
      if (!picked_price_type || picked_price == null) {
        if (side === "home") {
          if (spreadHome != null) {
            picked_price_type = "spread";
            picked_price = spreadHome;
          } else if (mlHome != null) {
            picked_price_type = "ml";
            picked_price = mlHome;
          }
        } else {
          if (spreadAway != null) {
            picked_price_type = "spread";
            picked_price = spreadAway;
          } else if (mlAway != null) {
            picked_price_type = "ml";
            picked_price = mlAway;
          }
        }
      }

      const picked_snapshot = {
        at: new Date().toISOString(),
        home: game.home,
        away: game.away,
        spreadHome, spreadAway,
        mlHome, mlAway,
      };

      const apply = (next: PickSide | null) => {
        const setMap = contestType === "mm" ? setMmPicks : setPicks;
        setMap(prev => {
          const cp = { ...prev };
          if (next) cp[gameId] = { side: next };
          else delete cp[gameId];
          return cp;
        });
      };

      try {
        if (already) {
          apply(null);
          const { error } = await supabase
            .from("picks")
            .delete()
            .eq("user_id", userId)
            .eq("league", "nfl")
            .eq("week", week)
            .eq("game_id", gameId)
            .eq("contest_type", contestType);
          if (error) throw error;
          return;
        }

        apply(side);
        const { error } = await supabase
          .from("picks")
          .upsert(
            {
              user_id: userId,
              league: "nfl",
              week,
              game_id: gameId,
              side,
              commence_at: kickoff.toISOString(),
              locked: false,
              picked_price_type,
              picked_price,
              picked_snapshot,
              contest_type: contestType,
            },
            {
              // Match the DB unique constraint: (user_id, game_id, contest_type)
              onConflict: "user_id,game_id,contest_type",
            }
          );
        if (error) throw error;
      } catch (err) {
        console.error("Save pick error:", err);
        // roll back local Weekly Pick'em or MM state
        if (contestType === "pickem" || contestType === "mm") {
          const setMap = contestType === "mm" ? setMmPicks : setPicks;
          setMap(prev => {
            const cp = { ...prev };
            if (already) cp[gameId] = { side };
            else delete cp[gameId];
            return cp;
          });
        }
        alert("Failed to save pick.");
      }
    },
    [userId, picks, mmPicks]
  );

  const clear = useCallback(async () => {
    if (!userId) return;
    const week = getNflWeekNumber(new Date());
    try {
      const { error } = await supabase
        .from("picks")
        .delete()
        .eq("user_id", userId)
        .eq("league", "nfl")
        .eq("week", week)
        .eq("contest_type", "pickem");
      if (error) throw error;
      setPicks({});
    } catch (e) {
      console.error("Clear picks error:", e);
    }
  }, [userId]);

  return {
    picks,
    mmPicks,
    count,
    mmCount,
    togglePick,
    clear,
    isLocked,
    loading,
    isAuthed: !!userId,
    ready,
  };
}