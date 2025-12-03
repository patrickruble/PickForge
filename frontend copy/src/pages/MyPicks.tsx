// src/pages/MyPicks.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { ensureSession } from "../lib/session";
import { getNflWeekNumber } from "../hooks/useRemotePicks";
import { useLines } from "../api/useLines";
import TeamBadge from "../components/TeamBadge";

type PickRow = {
  game_id: string;
  side: "home" | "away";
  league: "nfl";
  week: number;
  commence_at: string;
  picked_price_type?: "ml" | "spread" | null;
  picked_price?: number | null;
  picked_snapshot?: any | null;
};

const fmtSigned = (n: number | null | undefined) =>
  typeof n === "number" ? (n > 0 ? `+${n}` : `${n}`) : "—";

export default function MyPicks() {
  const [uid, setUid] = useState<string | null>(null);
  const [rows, setRows] = useState<PickRow[]>([]);
  const [loadingPicks, setLoadingPicks] = useState(true);

  // lines (don’t gate UI on these)
  const { games, isLoading: linesLoading } = useLines("nfl");

  // id -> minimal game info
  const gameMap = useMemo(() => {
    const m = new Map<string, any>();
    for (const g of games) {
      m.set(g.id, {
        home: g.home,
        away: g.away,
        spreadHome: g.spreadHome ?? null,
        spreadAway: g.spreadAway ?? null,
        mlHome: g.moneyline?.[g.home] ?? null,
        mlAway: g.moneyline?.[g.away] ?? null,
      });
    }
    return m;
  }, [games]);

  // 1) Guarantee there is a session (anon fallback) and keep it fresh
  useEffect(() => {
    let mounted = true;

    async function init() {
      const id = await ensureSession(); // creates anon session if none
      if (!mounted) return;
      setUid(id);

      // keep UID updated on auth changes
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        if (!mounted) return;
        setUid(session?.user?.id ?? null);
      });
      return () => sub.subscription.unsubscribe();
    }

    const cleanup = init();
    return () => {
      mounted = false;
      // await cleanup if it was a promise
      if (cleanup && typeof (cleanup as any) === "function") (cleanup as any)();
    };
  }, []);

  // 2) Load picks whenever uid is known
  useEffect(() => {
    if (!uid) return; // will be set by ensureSession()
    let cancelled = false;

    (async () => {
      setLoadingPicks(true);
      try {
        const week = getNflWeekNumber(new Date());
        const { data, error } = await supabase
          .from("picks")
          .select(
            "game_id, side, league, week, commence_at, picked_price_type, picked_price, picked_snapshot"
          )
          .eq("user_id", uid)
          .eq("league", "nfl")
          .eq("week", week)
          .order("commence_at", { ascending: true });

        if (!cancelled) {
          if (error) {
            console.error("load picks error:", error);
            setRows([]);
          } else {
            setRows((data ?? []) as PickRow[]);
          }
        }
      } finally {
        if (!cancelled) setLoadingPicks(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid]);

  const weekNum = getNflWeekNumber(new Date());

  // Top-level loading (only while we’re establishing uid or fetching picks)
  if (!uid || loadingPicks) {
    return (
      <div className="p-6 text-slate-300">
        <h1 className="text-2xl font-bold text-yellow-400 mb-4">My Picks (Week {weekNum})</h1>
        Loading…
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="p-6 text-slate-300">
        <h1 className="text-2xl font-bold text-yellow-400 mb-4">My Picks (Week {weekNum})</h1>
        No picks yet for this week.{" "}
        <a className="text-yellow-400 underline" href="/">Go make your picks →</a>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-yellow-400 mb-4">My Picks (Week {weekNum})</h1>

      <ul className="space-y-3">
        {rows.map((r) => {
          const gm = gameMap.get(r.game_id);
          const home = gm?.home ?? "HOME";
          const away = gm?.away ?? "AWAY";
          const when = new Date(r.commence_at).toLocaleString();

          // Prefer saved price; else show current side’s line
          let label = "";
          if (r.picked_price_type) {
            label =
              r.picked_price_type === "spread"
                ? `Spread ${fmtSigned(r.picked_price ?? null)} (saved)`
                : `ML ${fmtSigned(r.picked_price ?? null)} (saved)`;
          } else if (gm) {
            if (r.side === "home") {
              label =
                gm.spreadHome != null
                  ? `Spread ${fmtSigned(gm.spreadHome)}`
                  : gm.mlHome != null
                  ? `ML ${fmtSigned(gm.mlHome)}`
                  : "";
            } else {
              label =
                gm.spreadAway != null
                  ? `Spread ${fmtSigned(gm.spreadAway)}`
                  : gm.mlAway != null
                  ? `ML ${fmtSigned(gm.mlAway)}`
                  : "";
            }
            if (label) label += " (current line)";
          } else {
            label = "(resolving teams…)";
          }

          const pickedIsAway = r.side === "away";
          const pickedPill =
            "px-2 py-0.5 rounded bg-yellow-400/15 text-yellow-300 border border-yellow-600/40";
          const normal = "text-slate-200";

          return (
            <li key={`${r.game_id}-${r.side}`} className="rounded-xl p-3 bg-slate-800/70">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={pickedIsAway ? pickedPill : normal}>
                    <div className="flex items-center gap-2">
                      <TeamBadge name={away} align="left" />
                    </div>
                  </div>
                  <span className="text-slate-400 text-sm">vs</span>
                  <div className={!pickedIsAway ? pickedPill : normal}>
                    <div className="flex items-center gap-2">
                      <TeamBadge name={home} align="right" />
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs uppercase text-slate-400">{r.side}</div>
                  {label && <div className="text-[11px] text-slate-400">{label}</div>}
                </div>
              </div>

              <div className="mt-1 text-xs text-slate-400">{when}</div>
            </li>
          );
        })}
      </ul>

      {linesLoading && (
        <p className="mt-3 text-xs text-slate-400">Updating live lines…</p>
      )}
    </div>
  );
}