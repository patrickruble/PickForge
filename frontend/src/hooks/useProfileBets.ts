import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BetRow, BetStatus, BetVisibility } from "../types/bets";

type UseProfileBetsResult = {
  bets: BetRow[];
  loading: boolean;
  error: string | null;
  isSelf: boolean;
  canSeeFollowersBets: boolean;
  summary: {
    total: number;
    wins: number;
    losses: number;
    pushes: number;
    net: number;
    roi: number;
    staked: number;
  };
};

export function useProfileBets(profileUserId: string | null): UseProfileBetsResult {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [bets, setBets] = useState<BetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canSeeFollowersBets, setCanSeeFollowersBets] = useState(false);

  // load viewer
  useEffect(() => {
    let cancelled = false;

    async function loadViewer() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (cancelled) return;
      const u = session?.user ?? null;
      setViewerId(u?.id ?? null);
    }

    loadViewer();
    return () => {
      cancelled = true;
    };
  }, []);

  // load follower relationship + bets
  useEffect(() => {
    if (!profileUserId) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const isSelf = viewerId && viewerId === profileUserId;

        let followerCanSeeFollowers = false;
        if (!isSelf && viewerId) {
          // adjust table / column names if your follows schema differs
          const { data, error } = await supabase
            .from("follows")
            .select("id")
            .eq("follower_id", viewerId)
            .eq("followee_id", profileUserId)
            .maybeSingle();

          if (error && error.code !== "PGRST116") {
            // ignore "no rows" error, but log others
            console.error("[useProfileBets] follow check error:", error);
          }

          followerCanSeeFollowers = !!data;
        }

        if (!cancelled) {
          setCanSeeFollowersBets(isSelf || followerCanSeeFollowers);
        }

        // load bets for that profile user
        const { data: raw, error: betError } = await supabase
          .from("bets")
          .select("*")
          .eq("user_id", profileUserId)
          .order("event_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(50);

        if (betError) throw betError;

        const allBets = (raw ?? []) as BetRow[];
        const visible = allBets.filter((b) => {
          const visibility = (b.visibility ?? "private") as BetVisibility;

          if (isSelf) return true; // owner sees everything
          if (visibility === "public") return true;
          if (visibility === "followers") return followerCanSeeFollowers;
          return false; // private to others
        });

        if (!cancelled) {
          setBets(visible);
        }
      } catch (e: any) {
        console.error("[useProfileBets] load error:", e);
        if (!cancelled) setError(e.message ?? "Failed to load bets");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [profileUserId, viewerId]);

  const isSelf = !!viewerId && !!profileUserId && viewerId === profileUserId;

  const summary = useMemo(() => {
    if (!bets.length) {
      return {
        total: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        net: 0,
        staked: 0,
        roi: 0,
      };
    }

    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let net = 0;
    let staked = 0;

    for (const b of bets) {
      staked += b.stake;
      net += b.result_amount;

      if (b.status === "won") wins++;
      else if (b.status === "lost") losses++;
      else if (b.status === "push") pushes++;
    }

    const total = wins + losses + pushes;
    const roi = staked > 0 ? (net / staked) * 100 : 0;

    return {
      total,
      wins,
      losses,
      pushes,
      net: +net.toFixed(2),
      staked: +staked.toFixed(2),
      roi: +roi.toFixed(2),
    };
  }, [bets]);

  return {
    bets,
    loading,
    error,
    isSelf,
    canSeeFollowersBets,
    summary,
  };
}