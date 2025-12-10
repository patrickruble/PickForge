import { useState } from "react";
// src/components/GameBoard.tsx
import { useLines } from "../api/useLines";
import { useRemotePicks, getNflWeekNumber } from "../hooks/useRemotePicks";
import useNow from "../hooks/useNow";
import TeamBadge from "../components/TeamBadge";
import { usePageSeo } from "../hooks/usePageSeo";

/* -----------------------
   Utility / formatting
--------------------------*/

function getSide(p: unknown): "home" | "away" | undefined {
  if (!p) return undefined;
  if (typeof p === "string") return p === "home" || p === "away" ? p : undefined;
  if (typeof p === "object" && p && "side" in (p as any)) {
    const s = (p as any).side;
    return s === "home" || s === "away" ? s : undefined;
  }
  return undefined;
}

const fmtOdds = (v?: number | null) =>
  typeof v === "number" ? (v > 0 ? `+${v}` : String(v)) : "—";

const fmtSigned = (v?: number | null) =>
  typeof v === "number" ? (v > 0 ? `+${v}` : String(v)) : "—";

function fmtCountdown(commenceIso: string, nowMs: number): string {
  const ms = new Date(commenceIso).getTime() - nowMs;
  if (ms <= 0) return "Started";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/* -----------------------
   NFL week & buckets
--------------------------*/

function startOfDayLocal(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Tue 00:00 → next Tue 00:00 local */
function currentNflWeekWindow(now = new Date()) {
  const today = startOfDayLocal(now);
  const dow = today.getDay(); // 0=Sun, 1=Mon, 2=Tue, ...
  const daysSinceTue = (dow - 2 + 7) % 7;
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - daysSinceTue);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  return { weekStart, weekEnd };
}

/** Buckets: Thu, Sun 12/3/Night, Mon, otherwise weekday name */
function bucketLabel(dt: Date): string {
  const day = dt.getDay();
  const hr = dt.getHours();

  if (day === 4) return "Thursday";
  if (day === 1) return "Monday";
  if (day === 0) {
    if (hr >= 18) return "Sunday Night";
    if (hr >= 14 && hr <= 16) return "Sunday 3";
    if (hr >= 11 && hr <= 13) return "Sunday 12";
    return "Sunday 12";
  }
  return dt.toLocaleDateString(undefined, { weekday: "long" });
}

const SECTION_ORDER = [
  "Thursday",
  "Sunday 12",
  "Sunday 3",
  "Sunday Night",
  "Monday",
  "Friday",
  "Saturday",
];

/* -----------------------
         MAIN UI
--------------------------*/

export default function GameBoard() {
  // SEO for the “home” page
  usePageSeo({
    title: "PickForge — Free NFL Pick’em, Weekly Picks & Leaderboard",
    description:
      "Free NFL pick’em game. Make weekly NFL picks against the spread and moneyline, track your record and ROI, and compete on the PickForge leaderboard.",
  });

  // Game mode: standard weekly pick'em vs Moneyline Mastery view
  const [mode, setMode] = useState<"standard" | "mm">("standard");

  const { games, isLoading, isValidating, error, refresh } = useLines("nfl");

  // Supabase picks – togglePick(game, side)
  const { picks, count, togglePick, clear, isLocked, isAuthed } =
    useRemotePicks();

  // Ticker for countdowns
  const now = useNow(30_000);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 text-sm text-red-400">
        Failed to load lines. Please refresh or try again in a minute.
      </div>
    );
  }

  if (isLoading && !games.length) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold">
              NFL Lines — <span className="text-yellow-400">Loading…</span>
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Weekly spread and moneyline board.
            </p>
          </div>
          <div className="h-7 w-7 rounded-full border border-slate-700 flex items-center justify-center">
            <span className="h-3 w-3 rounded-full bg-yellow-400 animate-pulse" />
          </div>
        </div>

        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 rounded-xl bg-slate-900/80 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!games.length) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 text-sm text-slate-300">
        <h1 className="text-2xl sm:text-3xl font-semibold mb-2">
          NFL Lines —{" "}
          <span className="text-yellow-400">
            Week {getNflWeekNumber(new Date())}
          </span>
        </h1>
        <p>No games are currently posted for this week.</p>
      </div>
    );
  }

  // Current week and Tue→Tue window
  const { weekStart, weekEnd } = currentNflWeekWindow(new Date(now));
  const week = getNflWeekNumber(new Date(now));
  const windowLabel = `${weekStart.toLocaleDateString()} – ${weekEnd.toLocaleDateString()}`;

  // Only show this week's games
  const weeklyGames = games
    .filter((g) => {
      const t = new Date(g.commenceTime);
      return t >= weekStart && t < weekEnd;
    })
    .sort(
      (a, b) =>
        new Date(a.commenceTime).getTime() -
        new Date(b.commenceTime).getTime()
    );

  // Group by section
  const grouped = new Map<string, typeof weeklyGames>();
  for (const g of weeklyGames) {
    const label = bucketLabel(new Date(g.commenceTime));
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(g);
  }
  const labels = [
    ...SECTION_ORDER.filter((k) => grouped.has(k)),
    ...Array.from(grouped.keys()).filter((k) => !SECTION_ORDER.includes(k)),
  ];

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 py-5 sm:py-6 text-slate-100">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3 sm:mb-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
            Weekly Picks —{" "}
            <span className="text-yellow-400">NFL Week {week}</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            {mode === "mm"
              ? "Moneyline Mastery view — focus on your moneyline picks. Games lock at kickoff."
              : "Tap a side to lock in your weekly pick. Games lock at kickoff."}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">{windowLabel}</p>
        </div>

        <div className="flex flex-col items-end gap-2 text-[11px] sm:text-xs">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/80">
            <span
              className={`h-2 w-2 rounded-full ${
                isValidating
                  ? "bg-yellow-400 animate-pulse"
                  : "bg-emerald-400"
              }`}
            />
            <span className="text-slate-200">
              {isValidating ? "Refreshing lines…" : "Live odds"}
            </span>
          </div>
          <div className="inline-flex items-center gap-2 text-slate-300">
            <span className="text-slate-400">Picks selected:</span>
            <span className="font-semibold text-yellow-400 font-mono text-sm">
              {count}
            </span>
          </div>
          <div className="flex items-center bg-slate-900/80 border border-slate-700/80 rounded-full p-1">
            <button
              type="button"
              onClick={() => setMode("standard")}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs transition ${
                mode === "standard"
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
      </div>

      {/* Actions row */}
      <div className="flex items-center justify-between mb-3 sm:mb-4 text-[11px] sm:text-xs">
        <button
          onClick={refresh}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-60 disabled:cursor-not-allowed"
          disabled={isValidating}
          title="Refresh odds"
        >
          {isValidating && (
            <span className="inline-block h-3 w-3 rounded-full border-2 border-black/40 border-t-black animate-spin" />
          )}
          Refresh lines
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={clear}
            disabled={count === 0}
            className="px-3 py-1.5 rounded-full border border-slate-700 text-slate-200 hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              count === 0 ? "No picks to clear" : "Clear all picks for this week"
            }
          >
            Clear all picks
          </button>
          {!isAuthed && (
            <span className="hidden sm:inline text-[11px] text-slate-500">
              Login to save picks to your profile.
            </span>
          )}
        </div>
      </div>

      {/* Game grid card */}
      <div className="overflow-hidden rounded-2xl shadow-lg shadow-black/30 ring-1 ring-slate-800 bg-slate-950/70">
        {/* Desktop header row (hidden on mobile) */}
        <div className="hidden sm:grid grid-cols-12 px-4 py-2 text-[10px] sm:text-xs uppercase tracking-wide text-slate-400 border-b border-slate-800">
          <div className="col-span-5">Away</div>
          <div className="col-span-2 text-center">
            {mode === "mm" ? "Moneyline / Lock" : "Spread / Lock"}
          </div>
          <div className="col-span-5 text-right">Home</div>
        </div>

        {labels.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-400">
            No games this week.
          </div>
        ) : (
          labels.map((label) => {
            const section = grouped.get(label)!;
            return (
              <div
                key={`sec-${label}`}
                className="border-b border-slate-900 last:border-b-0"
              >
                <div className="px-3 sm:px-4 py-1.5 bg-slate-950/95 text-[11px] font-semibold text-slate-300 border-y border-slate-900">
                  {label}
                </div>

                <ul className="divide-y divide-slate-900/80">
                  {section.map((g) => {
                    const homeML = g.moneyline?.[g.home];
                    const awayML = g.moneyline?.[g.away];
                    const selectedSide = getSide(picks?.[g.id]);
                    const locked = isLocked(g.commenceTime, now);
                    const countdown = fmtCountdown(g.commenceTime, now);

                    const btnBase =
                      "px-2 py-1 rounded-full text-[11px] sm:text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
                    const isAway = selectedSide === "away";
                    const isHome = selectedSide === "home";
                    const awayCls = isAway
                      ? "bg-emerald-400 text-black border border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.5)]"
                      : "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700";
                    const homeCls = isHome
                      ? "bg-emerald-400 text-black border border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.5)]"
                      : "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700";

                    return (
                      <li
                        key={g.id}
                        className="px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-slate-900/60 transition-colors"
                      >
                        {/* Mobile: stacked; Desktop: 12-col grid */}
                        <div className="flex flex-col gap-2 sm:grid sm:grid-cols-12 sm:gap-2">
                          {/* Away */}
                          <div className="flex items-center gap-2 min-w-0 sm:col-span-5">
                            <div className="flex-1 min-w-0">
                              <TeamBadge name={g.away} align="left" />
                              {typeof awayML === "number" && (
                                <div className="mt-0.5 text-[10px] text-slate-400">
                                  ML {fmtOdds(awayML)}
                                </div>
                              )}
                            </div>
                            <button
                              className={`${btnBase} ${awayCls}`}
                              onClick={() => togglePick(g, "away")}
                              disabled={locked || !isAuthed}
                              title={
                                locked
                                  ? "Locked (game started)"
                                  : !isAuthed
                                  ? "Login to pick"
                                  : mode === "mm"
                                  ? "Moneyline pick (away)"
                                  : "Pick away"
                              }
                            >
                              {mode === "mm"
                                ? isAway
                                  ? `ML ${fmtOdds(awayML)}`
                                  : `ML ${fmtOdds(awayML)}`
                                : isAway
                                ? "Picked"
                                : "Pick"}
                            </button>
                          </div>

                          {/* Spread / lock (or ML focus in MM mode) */}
                          <div className="flex items-center justify-between sm:flex-col sm:justify-center sm:items-center sm:col-span-2 text-center gap-1">
                            <div className="text-[11px] sm:text-xs font-medium text-slate-200">
                              {mode === "mm" ? (
                                <>
                                  ML {fmtOdds(awayML)} / ML {fmtOdds(homeML)}
                                </>
                              ) : (
                                <>
                                  {fmtSigned(g.spreadAway ?? null)} /{" "}
                                  {fmtSigned(g.spreadHome ?? null)}
                                </>
                              )}
                            </div>
                            <span
                              className={
                                locked
                                  ? "inline-flex items-center px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 text-[10px]"
                                  : "inline-flex items-center px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-700/40 text-[10px]"
                              }
                            >
                              {locked ? "Locked" : `T-${countdown}`}
                            </span>
                          </div>

                          {/* Home */}
                          <div className="flex items-center gap-2 justify-between sm:justify-end min-w-0 sm:col-span-5">
                            <button
                              className={`${btnBase} ${homeCls}`}
                              onClick={() => togglePick(g, "home")}
                              disabled={locked || !isAuthed}
                              title={
                                locked
                                  ? "Locked (game started)"
                                  : !isAuthed
                                  ? "Login to pick"
                                  : mode === "mm"
                                  ? "Moneyline pick (home)"
                                  : "Pick home"
                              }
                            >
                              {mode === "mm"
                                ? isHome
                                  ? `ML ${fmtOdds(homeML)}`
                                  : `ML ${fmtOdds(homeML)}`
                                : isHome
                                ? "Picked"
                                : "Pick"}
                            </button>
                            <div className="flex-1 min-w-0 text-right">
                              <TeamBadge name={g.home} align="right" />
                              {typeof homeML === "number" && (
                                <div className="mt-0.5 text-[10px] text-slate-400">
                                  ML {fmtOdds(homeML)}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </div>

      {/* Tiny helper copy at bottom */}
      <p className="mt-3 text-[11px] text-slate-500">
        Picks are saved instantly to your account. You can change sides until a
        game locks at kickoff. Moneyline Mastery uses your graded moneyline
        picks across the season.
      </p>
    </div>
  );
}