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

// contest_type can be null for older rows
type ContestType = "pickem" | "mm" | null;

type PickRow = {
  game_id: string;
  side: "home" | "away";
  league: "nfl";
  week: number;
  commence_at: string;
  contest_type: ContestType;
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

// Compute risk and win for a standard 100-point MM stake based on American odds
const computeRiskWinFromOdds = (odds: number, stake = 100) => {
  if (!Number.isFinite(odds) || odds === 0) {
    return { risk: 0, win: 0 };
  }
  if (odds > 0) {
    // Underdog: risk stake to win odds% of stake
    return {
      risk: stake,
      win: (stake * odds) / 100,
    };
  }
  // Favorite: risk abs(odds)% of stake to win stake
  const abs = Math.abs(odds);
  return {
    risk: (stake * abs) / 100,
    win: stake,
  };
};

// Same grading logic as Stats: uses final score + the line you locked in
function gradePick(row: PickWithGame): Grade {
  const game = row.game;

  if (!game) return "pending";

  const home = game.home_score ?? null;
  const away = game.away_score ?? null;

  // Score-first: if scores exist, we can grade even if status is missing/mismatched.
  const hasScores = home != null && away != null;

  const status = typeof game.status === "string" ? game.status.toLowerCase() : "";
  const isTerminalStatus = ["final", "complete", "completed", "post", "closed"].includes(status);

  if (!hasScores && !isTerminalStatus) return "pending";
  if (!hasScores) return "pending";

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
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [rows, setRows] = useState<PickWithGame[]>([]);
  const [loadingPicks, setLoadingPicks] = useState(true);

  // Mode toggle: show Pick'em (spread) picks vs only Moneyline Mastery (ML) picks
  const [mode, setMode] = useState<"pickem" | "mm">("pickem");
  // Current NFL week (computed on render; cheap and avoids hook-order / TS "used before declaration" issues)
  const weekNum = getNflWeekNumber(new Date());

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

    // keep UID updated on auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!mounted) return;
      setUid(session?.user?.id ?? null);
    });

    (async () => {
      try {
        setSessionLoading(true);
        setSessionError(null);

        const id = await ensureSession(); // creates anon session if none
        if (!mounted) return;

        if (!id) {
          setUid(null);
          setSessionError("Couldn't create or restore a session. Try refreshing, or log out/in.");
        } else {
          setUid(id);
        }
      } catch (e: any) {
        if (!mounted) return;
        setUid(null);
        setSessionError(e?.message ?? "Failed to initialize session.");
      } finally {
        if (!mounted) return;
        setSessionLoading(false);
      }
    })();

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // 2) Load picks + their game results whenever uid is known
  useEffect(() => {
    if (!uid) return; // will be set by ensureSession()
    let cancelled = false;

    (async () => {
      setLoadingPicks(true);
      try {
        const { data, error } = await supabase
          .from("picks")
          .select(
            "game_id, side, league, week, commence_at, contest_type, picked_price_type, picked_price, picked_snapshot"
          )
          .eq("user_id", uid)
          .eq("league", "nfl")
          .eq("week", weekNum)
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
            .eq("league", "nfl")
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
  }, [uid, weekNum]);


  // Back-compat and improved classification for pickem and MM rows
  const pickemRows = useMemo(() => {
    return rows.filter((r) => {
      // Prefer explicit picked_price_type over heuristics.
      // Some spread picks can have picked_price temporarily null (or older rows), which
      // would incorrectly classify them as ML if we only check picked_price.
      const isExplicitSpread = r.picked_price_type === "spread";
      const isExplicitML = r.picked_price_type === "ml";

      // Back-compat: if price_type is missing, fall back to whether a spread value exists.
      const looksLikeSpread = r.picked_price != null;
      const looksLikeML = !looksLikeSpread;

      // Pick'em mode should include:
      // - contest_type === 'pickem'
      // - contest_type null but it looks like a spread pick
      // - explicit spread picks even if contest_type is missing
      if (r.contest_type === "pickem") return true;
      if (r.contest_type === "mm") return false;

      if (isExplicitSpread) return true;
      if (isExplicitML) return false;

      return r.contest_type == null && looksLikeSpread;
    });
  }, [rows]);

  const mmRows = useMemo(() => {
    return rows.filter((r) => {
      const isExplicitSpread = r.picked_price_type === "spread";
      const isExplicitML = r.picked_price_type === "ml";

      const looksLikeSpread = r.picked_price != null;
      const looksLikeML = !looksLikeSpread;

      // MM should include:
      // - contest_type === 'mm'
      // - contest_type null but it looks like an ML pick
      // - explicit ML picks even if contest_type is missing
      if (r.contest_type === "mm") return true;
      if (r.contest_type === "pickem") return false;

      if (isExplicitML) return true;
      if (isExplicitSpread) return false;

      return r.contest_type == null && looksLikeML;
    });
  }, [rows]);

  // What we actually show in the list:
  // - Pick'em picks in "Pick'em" mode
  // - Only MM picks in "MM" mode
  const visibleRows = useMemo(
    () => (mode === "pickem" ? pickemRows : mmRows),
    [mode, pickemRows, mmRows]
  );

  // -------- Loading state --------

  if (sessionLoading || loadingPicks) {
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

  if (!uid) {
    return (
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-6 text-slate-300">
        <header className="mb-3">
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            My Picks — Week {weekNum}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            {sessionError ?? "You are not signed in and a session could not be created."}
          </p>
        </header>

        <p className="text-sm text-slate-300">
          Try refreshing the page. If it keeps happening, log out and log back in.
        </p>
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
              {mode === "pickem" ? pickemRows.length : mmRows.length}
            </span>{" "}
            {mode === "pickem" ? "Pick'em picks locked in." : "ML picks locked in."}
            {mode === "mm" && (
              <span className="ml-1 text-slate-500">
                ({mmRows.length} ML picks for Moneyline Mastery.)
              </span>
            )}
          </div>
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
            <button
              type="button"
              onClick={() => setMode("pickem")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                mode === "pickem"
                  ? "bg-yellow-400 text-slate-900 font-semibold shadow-[0_0_10px_rgba(250,204,21,0.6)]"
                  : "text-slate-300 hover:text-slate-100"
              }`}
            >
              Pick&apos;em
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

          // Prefer saved price; else show current side’s line or snapshot.
          // In MM mode, we always show a moneyline for the picked team if we have one.
          let label = "";
          let riskWinText = "";

          if (mode === "mm") {
            // Moneyline Mastery view: show ML for the side you picked
            let ml: number | null = null;
            let source: "saved" | "current" | null = null;

            // If this pick was explicitly saved as ML, use that first
            if (r.picked_price_type === "ml" && r.picked_price != null) {
              ml = r.picked_price;
              source = "saved";
            } else if (gm) {
              if (r.side === "home" && gm.mlHome != null) {
                ml = gm.mlHome;
                source = "current";
              } else if (r.side === "away" && gm.mlAway != null) {
                ml = gm.mlAway;
                source = "current";
              }
            }

            // Fallback to snapshot ML if we have it
            if (ml == null && snap) {
              if (r.side === "home" && snap.mlHome != null) {
                ml = snap.mlHome;
                source = "saved";
              } else if (r.side === "away" && snap.mlAway != null) {
                ml = snap.mlAway;
                source = "saved";
              }
            }

            // MM mode: show ML *display*, but also show original spread pick if it exists
            if (ml != null) {
              if (r.picked_price_type === "spread" && r.picked_price != null) {
                // Show BOTH: your Moneyline for MM scoring AND the actual spread you locked
                label = `ML ${fmtSigned(ml)}${
                  source === "saved"
                    ? " (saved)"
                    : source === "current"
                    ? " (current line)"
                    : ""
                } • Spread ${fmtSigned(r.picked_price)} (saved)`;
              } else {
                // Pure moneyline pick
                label = `ML ${fmtSigned(ml)}${
                  source === "saved"
                    ? " (saved)"
                    : source === "current"
                    ? " (current line)"
                    : ""
                }`;
              }
            }
            if (ml != null) {
              const { risk, win } = computeRiskWinFromOdds(ml, 100);
              riskWinText = `Max loss: ${risk.toFixed(0)} pts · Max win: ${win.toFixed(0)} pts`;
            }
          } else {
            // Normal view: for Pick'em, prefer the spread you locked in.
            if (r.picked_price_type) {
              if (r.picked_price_type === "spread" && r.picked_price != null) {
                // Classic spread pick
                label = `Spread ${fmtSigned(r.picked_price)} (saved)`;
              } else if (r.picked_price_type === "ml") {
                // This pick has an ML saved at the row level, but for Pick'em
                // we still want to show the spread you locked, if we have it
                let spreadForSide: number | null = null;
                if (snap) {
                  if (r.side === "home" && snap.spreadHome != null) {
                    spreadForSide = snap.spreadHome;
                  } else if (r.side === "away" && snap.spreadAway != null) {
                    spreadForSide = snap.spreadAway;
                  }
                }

                if (spreadForSide != null) {
                  label = `Spread ${fmtSigned(spreadForSide)} (saved)`;
                } else {
                  // Fallback: we at least show the saved ML
                  label = `ML ${fmtSigned(r.picked_price ?? null)} (saved)`;
                }
              } else {
                // Fallback for any other future type
                label = `ML ${fmtSigned(r.picked_price ?? null)} (saved)`;
              }
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

          // default pending
          let tint = "bg-slate-950/80 border border-slate-800";

          if (grade === "win") {
            tint =
              "bg-emerald-950/40 border border-emerald-500 shadow-emerald-500/30";
          } else if (grade === "loss") {
            tint =
              "bg-rose-950/40 border border-rose-500 shadow-rose-500/30";
          } else if (grade === "push") {
            tint =
              "bg-slate-700/40 border border-slate-400 shadow-slate-500/30";
          }

          return (
            <li
              key={`${r.game_id}-${r.side}-${r.contest_type ?? "na"}-${r.picked_price_type ?? "na"}`}
              className={`${baseCard} ${tint}`}
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
                  {mode === "mm" && riskWinText && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {riskWinText}
                    </div>
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