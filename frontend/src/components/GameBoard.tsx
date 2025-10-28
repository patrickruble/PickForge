// src/components/GameBoard.tsx
import { useLines } from "../api/useLines";

function fmtKickoff(iso?: string) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso ?? "";
  }
}

function fmtOdds(v: number | null | undefined) {
  return typeof v === "number" ? (v > 0 ? `+${v}` : String(v)) : "—";
}

export default function GameBoard() {
  const { games, isLoading, isValidating, error, refresh } = useLines("nfl");

  if (error) return <p className="text-red-500">Failed to load lines.</p>;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!games.length) return <p className="text-gray-400">No games found.</p>;

  return (
    <div className="max-w-4xl mx-auto p-4 text-gray-100">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-semibold">NFL Lines</h2>
        <button
          onClick={refresh}
          className="inline-flex items-center gap-2 px-3 py-1 rounded bg-yellow-400 text-black hover:bg-yellow-300 disabled:opacity-60"
          disabled={isValidating}
          aria-busy={isValidating ? "true" : "false"}
          aria-live="polite"
          aria-label={isValidating ? "Refreshing odds" : "Refresh odds"}
        >
          {isValidating && (
            <span
              role="status"
              aria-live="polite"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/40 border-t-black"
            />
          )}
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-lg shadow ring-1 ring-black/10 bg-gray-900">
        {/* Header row */}
        <div className="grid grid-cols-12 px-4 py-2 text-xs uppercase tracking-wide text-gray-400 border-b border-gray-700">
          <div className="col-span-5">Away</div>
          <div className="col-span-2 text-center">Spread</div>
          <div className="col-span-5 text-right">Home / ML</div>
        </div>

        {/* Games */}
        <ul className="divide-y divide-gray-800">
          {games.map((g) => {
            const homeML = g.moneyline?.[g.home];
            const awayML = g.moneyline?.[g.away];

            return (
              <li key={g.id} className="grid grid-cols-12 gap-2 px-4 py-3">
                <div className="col-span-5">
                  <p className="font-medium">{g.away}</p>
                  <p className="text-xs text-gray-500">
                    @ {g.home} • {fmtKickoff(g.commenceTime)}
                  </p>
                </div>

                <div className="col-span-2 text-center">
                  <p className="text-sm">
                    {g.spreadAway ?? "—"} / {g.spreadHome ?? "—"}
                  </p>
                  <p className="text-[11px] text-gray-500">Spread</p>
                </div>

                <div className="col-span-5 text-right">
                  <div className="text-sm">
                    <span className="inline-block min-w-16">
                      {g.home}: {fmtOdds(homeML)}
                    </span>
                    <span className="inline-block min-w-16 ml-3">
                      {g.away}: {fmtOdds(awayML)}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    {g.source ?? "—"}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="mt-3 text-xs text-gray-500">
        Odds refresh automatically every minute.
      </p>
    </div>
  );
}