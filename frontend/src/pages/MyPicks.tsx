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

  // Lines (we only use them for context; don't block UI on them)
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
      if (cleanup && typeof (cleanup as any) === "function") {
        (cleanup as any)();
      }
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

  // -------- Loading state --------

  if (!uid || loadingPicks) {
    return (
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 text-slate-300">
        <header className="mb-4">
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            My Picks — Week {weekNum}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Fetching your picks for this week…
          </p>
        </header>

        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded-xl bg-slate-900/80 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  // -------- Empty state --------

  if (!rows.length) {
    return (
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 text-slate-300">
        <header className="mb-3">
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            My Picks — Week {weekNum}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            You haven't locked anything in yet this week.
          </p>
        </header>

        <p className="text-sm text-slate-300">
          Head over to{" "}
          <a href="/" className="text-yellow-400 underline">
            Weekly Picks
          </a>{" "}
          to make your selections.
        </p>
      </div>
    );
  }

  // -------- Main UI --------

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 text-slate-100">
      <header className="mb-4 sm:mb-5 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            My Picks — Week {weekNum}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            These are your saved picks for this week’s NFL games.
          </p>
        </div>
        <div className="text-[11px] sm:text-xs text-slate-400">
          <span className="font-semibold text-slate-100">{rows.length}</span>{" "}
          picks locked in.
        </div>
      </header>

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
            "px-2.5 py-1 rounded-full bg-yellow-400/15 text-yellow-300 border border-yellow-600/40";
          const normal =
            "px-2.5 py-1 rounded-full bg-slate-800/80 text-slate-100 border border-slate-700/70";

          return (
            <li
              key={`${r.game_id}-${r.side}`}
              className="rounded-2xl p-3 sm:p-4 bg-slate-950/80 border border-slate-800 shadow-sm shadow-black/30"
            >
              <div className="flex flex-col gap-2 sm:gap-3 sm:flex-row sm:items-center sm:justify-between">
                {/* Left: matchup */}
                <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={pickedIsAway ? pickedPill : normal}>
                        <div className="flex items-center gap-2 min-w-0">
                          <TeamBadge name={away} align="left" />
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[10px] uppercase text-slate-500">
                        vs
                      </span>
                      <div className={!pickedIsAway ? pickedPill : normal}>
                        <div className="flex items-center gap-2 min-w-0">
                          <TeamBadge name={home} align="right" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right: side + line info */}
                <div className="text-right min-w-[40%] sm:min-w-[32%]">
                  <div className="text-[11px] uppercase text-slate-400 mb-0.5">
                    You picked{" "}
                    <span className="font-semibold text-slate-100">
                      {pickedIsAway ? away : home}
                    </span>
                  </div>
                  {label && (
                    <div className="text-[11px] text-slate-400">{label}</div>
                  )}
                  <div className="mt-1 text-[11px] text-slate-500">{when}</div>
                </div>
              </div>

              {linesLoading && (
                <p className="mt-2 text-[10px] text-slate-500">
                  Updating live lines…
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}