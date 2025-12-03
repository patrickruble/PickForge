// src/components/GameBoard.tsx
import { useLines } from "../api/useLines";
import { useRemotePicks, getNflWeekNumber } from "../hooks/useRemotePicks";
import useNow from "../hooks/useNow";
import TeamBadge from "../components/TeamBadge";

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
  const { games, isLoading, isValidating, error, refresh } = useLines("nfl");

  // Supabase picks – togglePick(game, side)
const { picks, count, togglePick, clear, isLocked, isAuthed } = useRemotePicks();
  // Ticker for countdowns
  const now = useNow(30_000);

  if (error) return <p className="text-red-500">Failed to load lines.</p>;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!games.length) return <p className="text-gray-400">No games found.</p>;

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
    .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());

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
    <div className="max-w-4xl mx-auto p-4 text-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-semibold">
          NFL Lines — <span className="text-yellow-400">Week {week}</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="inline-flex items-center gap-2 px-3 py-1 rounded bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-60"
            disabled={isValidating}
            title="Refresh odds"
          >
            {isValidating && (
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/40 border-t-black" />
            )}
            Refresh
          </button>
          <button
            onClick={clear}
            disabled={count === 0}
            className="px-3 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            title={count === 0 ? "No picks to clear" : "Clear all picks"}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="mb-4 text-xs text-gray-400">{windowLabel}</p>

      {/* Live indicator */}
      <p className="mb-3 text-xs text-gray-400 flex items-center gap-3">
        <span className="inline-flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              isValidating ? "bg-yellow-400" : "bg-emerald-400"
            }`}
          />
          {isValidating ? "Refreshing…" : "Live"}
        </span>
        <span>
          Picks selected: <span className="font-semibold">{count}</span>
        </span>
      </p>

      {/* Game grid */}
      <div className="overflow-hidden rounded-lg shadow ring-1 ring-black/10 bg-gray-900">
        <div className="grid grid-cols-12 px-4 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-gray-700">
          <div className="col-span-5">Away</div>
          <div className="col-span-2 text-center">Spread</div>
          <div className="col-span-5 text-right">Home</div>
        </div>

        {labels.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-400">No games this week.</div>
        ) : (
          labels.map((label) => {
            const section = grouped.get(label)!;
            return (
              <div key={`sec-${label}`} className="border-b border-gray-800 last:border-b-0">
                <div className="px-4 py-2 bg-gray-950/40 text-xs font-semibold text-gray-300 sticky top-0">
                  {label}
                </div>

                <ul className="divide-y divide-gray-800">
                  {section.map((g) => {
                    const homeML = g.moneyline?.[g.home];
                    const awayML = g.moneyline?.[g.away];
                    const selectedSide = getSide(picks?.[g.id]);
                    const locked = isLocked(g.commenceTime, now);
                    const countdown = fmtCountdown(g.commenceTime, now);

                    const btnBase =
                      "px-2 py-1 rounded border text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
                    const isAway = selectedSide === "away";
                    const isHome = selectedSide === "home";
                    const awayCls = isAway
                      ? "bg-emerald-400/90 text-black border-emerald-300"
                      : "bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700";
                    const homeCls = isHome
                      ? "bg-emerald-400/90 text-black border-emerald-300"
                      : "bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700";

                    return (
                      <li key={g.id} className="grid grid-cols-12 gap-2 px-4 py-3">
                        {/* Away */}
                        <div className="col-span-5 flex items-center gap-2">
                        <button
                          className={`${btnBase} ${awayCls}`}
                          onClick={() => togglePick(g, "away")}
                          disabled={locked || !isAuthed}
                          title={
                            locked ? "Locked (game started)" :
                            !isAuthed ? "Login to pick" : "Pick away"
                          }
                        >
                          Pick
                        </button>
                          <TeamBadge name={g.away} align="left" />
                          {typeof awayML === "number" && (
                            <span className="ml-2 text-xs text-gray-400">
                              ML {fmtOdds(awayML)}
                            </span>
                          )}
                        </div>

                        {/* Spread */}
                        <div className="col-span-2 text-center">
                          <p className="text-sm">
                            {fmtSigned(g.spreadAway ?? null)} / {fmtSigned(g.spreadHome ?? null)}
                          </p>
                          <p className="text-[11px] text-gray-500">Spread</p>
                          <div className="mt-1">
                            <span
                              className={
                                locked
                                  ? "inline-flex items-center px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700 text-[10px]"
                                  : "inline-flex items-center px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-700/40 text-[10px]"
                              }
                            >
                              {locked ? "Locked" : `T-${countdown}`}
                            </span>
                          </div>
                        </div>

                        {/* Home */}
                        <div className="col-span-5 flex items-center justify-end gap-2 text-right">
                          {typeof homeML === "number" && (
                            <span className="text-xs text-gray-400">
                              ML {fmtOdds(homeML)}
                            </span>
                          )}
                          <TeamBadge name={g.home} align="right" />
                         <button
                          className={`${btnBase} ${homeCls}`}
                          onClick={() => togglePick(g, "home")}
                          disabled={locked || !isAuthed}
                          title={
                            locked ? "Locked (game started)" :
                            !isAuthed ? "Login to pick" : "Pick home"
                          }
                        >
                          Pick
                        </button>
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
    </div>
  );
}