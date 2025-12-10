// src/pages/MyPicks.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { ensureSession } from "../lib/session";
import { getNflWeekNumber } from "../hooks/useRemotePicks";
import { useLines } from "../api/useLines";
import TeamBadge from "../components/TeamBadge";

type PickSnapshot = {
  home?: string;
  away?: string;
  spreadHome?: number | null;
  spreadAway?: number | null;
  mlHome?: number | null;
  mlAway?: number | null;
};

type PickRow = {
  game_id: string;
  side: "home" | "away";
  league: "nfl";
  week: number;
  commence_at: string;
  picked_price_type?: "ml" | "spread" | null;
  picked_price?: number | null;
  picked_snapshot?: PickSnapshot | null;
};

type GameResult = {
  id: string;
  status: string | null;
  home_score: number | null;
  away_score: number | null;
};

type PickWithGame = PickRow & {
  game: GameResult | null;
};

type Grade = "pending" | "win" | "loss" | "push";

const fmtSigned = (n: number | null | undefined) =>
  typeof n === "number" ? (n > 0 ? `+${n}` : `${n}`) : "—";

// Same grading logic as Stats: uses final score + the line you locked in
function gradePick(row: PickWithGame): Grade {
  const game = row.game;
  if (!game || game.status !== "final") return "pending";

  const home = game.home_score ?? null;
  const away = game.away_score ?? null;
  if (home == null || away == null) return "pending";

  const pickedScore = row.side === "home" ? home : away;
  const otherScore = row.side === "home" ? away : home;

  // Moneyline or no spread: straight-up winner
  if (row.picked_price_type === "ml" || row.picked_price == null) {
    if (pickedScore > otherScore) return "win";
    if (pickedScore < otherScore) return "loss";
    return "push";
  }

  // Against the spread: picked_price is the line on the picked side
  const spread = row.picked_price;
  const spreadDiff = pickedScore + spread - otherScore;
  if (spreadDiff > 0) return "win";
  if (spreadDiff < 0) return "loss";
  return "push";
}

export default function MyPicks() {
  const [uid, setUid] = useState<string | null>(null);
  const [rows, setRows] = useState<PickWithGame[]>([]);
  const [loadingPicks, setLoadingPicks] = useState(true);

  // Mode toggle: show all weekly picks vs only Moneyline Mastery (ML) picks
  const [mode, setMode] = useState<"all" | "mm">("all");

  // Lines (we only use them for context; don't block UI on them)
  const { games, isLoading: linesLoading } = useLines("nfl");

  // id -> minimal game info for names / current lines
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

  // 2) Load picks + their game results whenever uid is known
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

        if (cancelled) return;

        if (error) {
          console.error("load picks error:", error);
          setRows([]);
          return;
        }

        const picks = (data ?? []) as PickRow[];
        if (!picks.length) {
          setRows([]);
          return;
        }

        // Fetch final scores / status for these games
        const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));
        let gameResults: GameResult[] = [];

        if (gameIds.length > 0) {
          const { data: gamesRaw, error: gamesError } = await supabase
            .from("games")
            .select("id, status, home_score, away_score")
            .in("id", gameIds);

          if (gamesError) {
            console.error("games load error:", gamesError);
          } else {
            gameResults = (gamesRaw ?? []) as GameResult[];
          }
        }

        const resultMap = new Map<string, GameResult>();
        for (const g of gameResults) {
          resultMap.set(g.id, g);
        }

        const combined: PickWithGame[] = picks.map((p) => ({
          ...p,
          game: resultMap.get(p.game_id) ?? null,
        }));

        setRows(combined);
      } finally {
        if (!cancelled) setLoadingPicks(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uid]);

  const weekNum = getNflWeekNumber(new Date());

  const visibleRows = useMemo(
    () =>
      mode === "all"
        ? rows
        : rows.filter(
            (r) => r.picked_price_type === "ml" && r.picked_price != null
          ),
    [mode, rows]
  );

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
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 text-[11px] sm:text-xs text-slate-400">
          <div>
            <span className="font-semibold text-slate-100">
              {visibleRows.length}
            </span>{" "}
            {mode === "all" ? "picks locked in." : "ML picks (Moneyline Mastery)."}
          </div>
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
            <button
              type="button"
              onClick={() => setMode("all")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                mode === "all"
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setMode("mm")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                mode === "mm"
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              MM
            </button>
          </div>
        </div>
      </header>

      <ul className="space-y-3">
        {visibleRows.map((r) => {
          const gm = gameMap.get(r.game_id);
          const snap = (r.picked_snapshot ?? {}) as PickSnapshot;

          // Prefer live lines hook for names; fall back to snapshot; then placeholder
          const home = gm?.home ?? snap.home ?? "HOME";
          const away = gm?.away ?? snap.away ?? "AWAY";
          const when = new Date(r.commence_at).toLocaleString();

          // Prefer saved price; else show current side’s line; else snapshot
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
          } else if (snap) {
            if (r.side === "home") {
              label =
                snap.spreadHome != null
                  ? `Spread ${fmtSigned(snap.spreadHome)} (saved)`
                  : snap.mlHome != null
                  ? `ML ${fmtSigned(snap.mlHome)} (saved)`
                  : "";
            } else {
              label =
                snap.spreadAway != null
                  ? `Spread ${fmtSigned(snap.spreadAway)} (saved)`
                  : snap.mlAway != null
                  ? `ML ${fmtSigned(snap.mlAway)} (saved)`
                  : "";
            }
          } else {
            label = "(resolving teams…)";
          }

          const pickedIsAway = r.side === "away";

          const pickedPill =
            "px-2.5 py-1 rounded-full bg-yellow-400/15 text-yellow-300 border border-yellow-600/40";
          const normal =
            "px-2.5 py-1 rounded-full bg-slate-800/80 text-slate-100 border border-slate-700/70";

          // ---------- grade + tint ----------
          const grade = gradePick(r);
          const baseCard =
  "rounded-2xl p-3 sm:p-4 shadow-sm shadow-black/30 transition-all";

let tint = "bg-slate-950/80 border border-slate-800"; // default pending

if (grade === "win") {
  tint =
    "bg-emerald-950/40 border border-emerald-500 shadow-emerald-500/30";
}

if (grade === "loss") {
  tint =
    "bg-rose-950/40 border border-rose-500 shadow-rose-500/30";
}

if (grade === "push") {
  tint =
    "bg-slate-700/40 border border-slate-400 shadow-slate-500/30";
}

          return (
            <li
              key={`${r.game_id}-${r.side}`}
              className={baseCard + (grade === "pending" ? "" : tint)}
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