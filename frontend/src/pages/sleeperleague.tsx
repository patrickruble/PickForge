import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  getSleeperLeague,
  getSleeperLeagueUsers,
  getSleeperRosters,
  getSleeperMatchups,
  type SleeperLeagueDetail,
  type SleeperLeagueUser,
  type SleeperRoster,
  type SleeperMatchup,
} from "../api/sleeper";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

type WLTTally = { w: number; l: number; t: number };

function tallyToString(t: WLTTally): string {
  return t.t > 0 ? `${t.w}-${t.l}-${t.t}` : `${t.w}-${t.l}`;
}

function formatSigned(n: number, digits: number = 1): string {
  const v = Number.isFinite(n) ? n : 0;
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}`;
}

type LuckStats = {
  actual: WLTTally;
  xw: number;
  luck: number;
};

export default function SleeperLeague() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [league, setLeague] = useState<SleeperLeagueDetail | null>(null);
  const [users, setUsers] = useState<SleeperLeagueUser[]>([]);
  const [rosters, setRosters] = useState<SleeperRoster[]>([]);

  const [leagueId, setLeagueId] = useState<string | null>(null);

  // Matchups
  const [week, setWeek] = useState<number>(1);
  const [matchupsLoading, setMatchupsLoading] = useState<boolean>(false);
  const [matchupsError, setMatchupsError] = useState<string | null>(null);
  const [matchups, setMatchups] = useState<SleeperMatchup[]>([]);

  const [medianRecLoading, setMedianRecLoading] = useState<boolean>(false);
  const [medianRecError, setMedianRecError] = useState<string | null>(null);
  const [medianRecordByRoster, setMedianRecordByRoster] = useState<
    Record<number, WLTTally>
  >({});

  const [luckByRoster, setLuckByRoster] = useState<Record<number, LuckStats>>({});

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const {
          data: { user },
          error: authErr,
        } = await supabase.auth.getUser();

        if (authErr) throw authErr;
        if (!user) throw new Error("Not authenticated");

        const { data: profile, error: profileErr } = await supabase
          .from("profiles")
          .select("sleeper_league_id")
          .eq("id", user.id)
          .single();

        if (profileErr) throw profileErr;
        if (!profile?.sleeper_league_id) {
          throw new Error("No Sleeper league connected yet.");
        }

        setLeagueId(profile.sleeper_league_id);

        const [leagueRes, usersRes, rostersRes] = await Promise.all([
          getSleeperLeague(profile.sleeper_league_id),
          getSleeperLeagueUsers(profile.sleeper_league_id),
          getSleeperRosters(profile.sleeper_league_id),
        ]);

        setLeague(leagueRes);
        setUsers(usersRes);
        setRosters(rostersRes);
      } catch (e: any) {
        setError(e?.message ?? "Failed to load Sleeper league.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  useEffect(() => {
    const loadMatchups = async () => {
      if (!leagueId) return;

      try {
        setMatchupsLoading(true);
        setMatchupsError(null);

        const data = await getSleeperMatchups(leagueId, week);
        setMatchups(data);
      } catch (e: any) {
        setMatchupsError(e?.message ?? "Failed to load matchups.");
        setMatchups([]);
      } finally {
        setMatchupsLoading(false);
      }
    };

    loadMatchups();
  }, [leagueId, week]);

  useEffect(() => {
    const loadMedianRecords = async () => {
      if (!leagueId) return;

      try {
        setMedianRecLoading(true);
        setMedianRecError(null);

        const weeksToFetch = Array.from({ length: week }, (_, i) => i + 1);
        const weekDatas = await Promise.all(
          weeksToFetch.map((w) => getSleeperMatchups(leagueId, w))
        );

        const acc: Record<number, WLTTally> = {};
        const actualAcc: Record<number, WLTTally> = {};
        const xwAcc: Record<number, number> = {};

        weekDatas.forEach((weekMatchups) => {
          const pts = weekMatchups
            .map((m) => (typeof m.points === "number" ? m.points : 0))
            .filter((p) => Number.isFinite(p));

          const med = median(pts);
          // Expected wins (xW): outscored/(teams-1) using weekly points rank
          const nTeams = weekMatchups.length;
          const rows = weekMatchups.map((m) => ({
            rid: m.roster_id,
            pts: typeof m.points === "number" ? m.points : 0,
            matchupId: m.matchup_id,
          }));

          if (nTeams > 1) {
            for (let i = 0; i < rows.length; i++) {
              const r = rows[i];
              const outscored = rows.filter((x) => r.pts > x.pts).length;
              xwAcc[r.rid] = (xwAcc[r.rid] ?? 0) + outscored / (nTeams - 1);
            }
          }

          // Actual matchup W/L/T by matchup_id
          const byMatchup = new Map<number, Array<{ rid: number; pts: number }>>();
          rows.forEach((r) => {
            const mid = r.matchupId;
            if (typeof mid !== "number") return;
            const arr = byMatchup.get(mid) ?? [];
            arr.push({ rid: r.rid, pts: r.pts });
            byMatchup.set(mid, arr);
          });

          byMatchup.forEach((pair) => {
            if (pair.length < 2) return;
            const a = pair[0];
            const b = pair[1];
            if (!actualAcc[a.rid]) actualAcc[a.rid] = { w: 0, l: 0, t: 0 };
            if (!actualAcc[b.rid]) actualAcc[b.rid] = { w: 0, l: 0, t: 0 };

            if (a.pts > b.pts) {
              actualAcc[a.rid].w += 1;
              actualAcc[b.rid].l += 1;
            } else if (a.pts < b.pts) {
              actualAcc[a.rid].l += 1;
              actualAcc[b.rid].w += 1;
            } else {
              actualAcc[a.rid].t += 1;
              actualAcc[b.rid].t += 1;
            }
          });

          if (med === null) return;

          weekMatchups.forEach((m) => {
            const rid = m.roster_id;
            const p = typeof m.points === "number" ? m.points : 0;
            if (!acc[rid]) acc[rid] = { w: 0, l: 0, t: 0 };

            if (p > med) acc[rid].w += 1;
            else if (p < med) acc[rid].l += 1;
            else acc[rid].t += 1;
          });
        });

        const luck: Record<number, LuckStats> = {};
        const rosterIds = new Set<number>([
          ...Object.keys(actualAcc).map((k) => Number(k)),
          ...Object.keys(xwAcc).map((k) => Number(k)),
        ]);

        rosterIds.forEach((rid) => {
          const actual = actualAcc[rid] ?? { w: 0, l: 0, t: 0 };
          const xw = xwAcc[rid] ?? 0;
          const actualWins = actual.w + 0.5 * actual.t;
          luck[rid] = { actual, xw, luck: actualWins - xw };
        });

        setMedianRecordByRoster(acc);
        setLuckByRoster(luck);
      } catch (e: any) {
        setMedianRecError(e?.message ?? "Failed to compute median records.");
        setMedianRecordByRoster({});
        setLuckByRoster({});
      } finally {
        setMedianRecLoading(false);
      }
    };

    loadMedianRecords();
  }, [leagueId, week]);

  const userById = useMemo(() => {
    const map = new Map<string, SleeperLeagueUser>();
    users.forEach((u) => map.set(u.user_id, u));
    return map;
  }, [users]);

  const rosterNameById = useMemo(() => {
    const map = new Map<number, string>();
    rosters.forEach((r) => {
      const owner = r.owner_id ? userById.get(r.owner_id) : null;
      map.set(r.roster_id, owner?.display_name ?? `Roster ${r.roster_id}`);
    });
    return map;
  }, [rosters, userById]);

  const matchupPairs = useMemo(() => {
    const groups = new Map<number, SleeperMatchup[]>();

    matchups.forEach((m) => {
      const key = m.matchup_id;
      if (typeof key !== "number") return;
      const group = groups.get(key) ?? [];
      group.push(m);
      groups.set(key, group);
    });

    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, group]) => group);
  }, [matchups]);

  const weekPoints = useMemo(() => {
    return matchups
      .map((m) => (typeof m.points === "number" ? m.points : 0))
      .filter((p) => Number.isFinite(p));
  }, [matchups]);

  const weekMedian = useMemo(() => median(weekPoints), [weekPoints]);

  if (loading) {
    return <div className="p-4">Loading Sleeper league…</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">{error}</div>;
  }

  if (!league || !leagueId) {
    return <div className="p-4">No league found.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{league.name}</h1>
        <div className="text-sm opacity-70">
          {league.season} • {league.total_rosters} teams • {league.status}
        </div>
      </div>

      <div className="mb-8 rounded-lg border p-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Matchups</h2>
            <p className="text-xs opacity-70">
              Pick a week to view head-to-head scores.
            </p>
          </div>

          <div className="w-28">
            <label
              htmlFor="sleeper-week"
              className="mb-1 block text-xs font-medium opacity-80"
            >
              Week
            </label>
            <input
              id="sleeper-week"
              className="w-full rounded border bg-transparent p-2"
              type="number"
              min={1}
              max={18}
              value={week}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setWeek(Number.isFinite(val) && val > 0 ? val : 1);
              }}
            />
          </div>
          <div className="text-xs opacity-70">
            {weekMedian === null ? (
              <>Median: —</>
            ) : (
              <>Median: {weekMedian.toFixed(1)}</>
            )}
          </div>
        </div>

        {matchupsLoading && (
          <div className="text-sm opacity-80">Loading matchups…</div>
        )}
        {matchupsError && (
          <div className="text-sm text-red-500">{matchupsError}</div>
        )}

        {medianRecLoading && (
          <div className="text-sm opacity-80">Computing median records…</div>
        )}
        {medianRecError && (
          <div className="text-sm text-red-500">{medianRecError}</div>
        )}

        {!matchupsLoading && !matchupsError && matchupPairs.length === 0 && (
          <div className="text-sm opacity-80">
            No matchups found for week {week}.
          </div>
        )}

        {!matchupsLoading && !matchupsError && matchupPairs.length > 0 && (
          <ul className="space-y-2">
            {matchupPairs.map((pair, idx) => {
              const sorted = [...pair].sort(
                (a, b) => (a.roster_id ?? 0) - (b.roster_id ?? 0)
              );
              const a = sorted[0];
              const b = sorted[1];

              const aName =
                rosterNameById.get(a.roster_id) ?? `Roster ${a.roster_id}`;
              const aPts = typeof a.points === "number" ? a.points : 0;

              if (!b) {
                return (
                  <li key={`${week}-${idx}`} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium">
                        {aName} <span className="opacity-70">({aPts})</span>
                      </div>

                      {weekMedian !== null && (
                        <span
                          className={
                            aPts > weekMedian
                              ? "rounded bg-green-600/20 px-2 py-1 text-xs text-green-300"
                              : aPts < weekMedian
                              ? "rounded bg-red-600/20 px-2 py-1 text-xs text-red-300"
                              : "rounded bg-yellow-600/20 px-2 py-1 text-xs text-yellow-200"
                          }
                        >
                          {aPts > weekMedian
                            ? "Beat median"
                            : aPts < weekMedian
                            ? "Below median"
                            : "At median"}
                        </span>
                      )}
                      {luckByRoster[a.roster_id] && (
                        <span
                          className={
                            luckByRoster[a.roster_id].luck > 0.5
                              ? "rounded bg-green-600/15 px-2 py-1 text-xs text-green-200"
                              : luckByRoster[a.roster_id].luck < -0.5
                              ? "rounded bg-red-600/15 px-2 py-1 text-xs text-red-200"
                              : "rounded bg-slate-500/15 px-2 py-1 text-xs text-slate-200"
                          }
                          title={`Expected wins through week ${week}: ${luckByRoster[a.roster_id].xw.toFixed(1)}`}
                        >
                          Luck {formatSigned(luckByRoster[a.roster_id].luck)}
                        </span>
                      )}
                    </div>
                    <div className="text-xs opacity-70">
                      Awaiting opponent
                      {medianRecordByRoster[a.roster_id] && (
                        <>
                          {" "}• Median record: {tallyToString(medianRecordByRoster[a.roster_id])}
                        </>
                      )}
                    </div>
                  </li>
                );
              }

              const bName =
                rosterNameById.get(b.roster_id) ?? `Roster ${b.roster_id}`;
              const bPts = typeof b.points === "number" ? b.points : 0;

              return (
                <li key={`${week}-${idx}`} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{aName}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-xs opacity-70">
                          Roster {a.roster_id}
                          {medianRecordByRoster[a.roster_id] && (
                            <> • Median: {tallyToString(medianRecordByRoster[a.roster_id])}</>
                          )}
                        </span>
                        {weekMedian !== null && (
                          <span
                            className={
                              aPts > weekMedian
                                ? "rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-300"
                                : aPts < weekMedian
                                ? "rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-300"
                                : "rounded bg-yellow-600/20 px-2 py-0.5 text-xs text-yellow-200"
                            }
                          >
                            {aPts > weekMedian
                              ? "Beat median"
                              : aPts < weekMedian
                              ? "Below median"
                              : "At median"}
                          </span>
                        )}
                        {luckByRoster[a.roster_id] && (
                          <span
                            className={
                              luckByRoster[a.roster_id].luck > 0.5
                                ? "rounded bg-green-600/15 px-2 py-0.5 text-xs text-green-200"
                                : luckByRoster[a.roster_id].luck < -0.5
                                ? "rounded bg-red-600/15 px-2 py-0.5 text-xs text-red-200"
                                : "rounded bg-slate-500/15 px-2 py-0.5 text-xs text-slate-200"
                            }
                            title={`Expected wins through week ${week}: ${luckByRoster[a.roster_id].xw.toFixed(1)}`}
                          >
                            Luck {formatSigned(luckByRoster[a.roster_id].luck)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 text-base font-semibold tabular-nums">
                      {aPts} — {bPts}
                    </div>

                    <div className="min-w-0 text-right">
                      <div className="truncate font-medium">{bName}</div>
                      <div className="mt-1 flex items-center justify-end gap-2">
                        {weekMedian !== null && (
                          <span
                            className={
                              bPts > weekMedian
                                ? "rounded bg-green-600/20 px-2 py-0.5 text-xs text-green-300"
                                : bPts < weekMedian
                                ? "rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-300"
                                : "rounded bg-yellow-600/20 px-2 py-0.5 text-xs text-yellow-200"
                            }
                          >
                            {bPts > weekMedian
                              ? "Beat median"
                              : bPts < weekMedian
                              ? "Below median"
                              : "At median"}
                          </span>
                        )}
                        {luckByRoster[b.roster_id] && (
                          <span
                            className={
                              luckByRoster[b.roster_id].luck > 0.5
                                ? "rounded bg-green-600/15 px-2 py-0.5 text-xs text-green-200"
                                : luckByRoster[b.roster_id].luck < -0.5
                                ? "rounded bg-red-600/15 px-2 py-0.5 text-xs text-red-200"
                                : "rounded bg-slate-500/15 px-2 py-0.5 text-xs text-slate-200"
                            }
                            title={`Expected wins through week ${week}: ${luckByRoster[b.roster_id].xw.toFixed(1)}`}
                          >
                            Luck {formatSigned(luckByRoster[b.roster_id].luck)}
                          </span>
                        )}
                        <span className="text-xs opacity-70">
                          Roster {b.roster_id}
                          {medianRecordByRoster[b.roster_id] && (
                            <> • Median: {tallyToString(medianRecordByRoster[b.roster_id])}</>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <h2 className="mb-3 text-lg font-semibold">Teams</h2>

      <ul className="space-y-2">
        {rosters.map((roster) => {
          const owner = roster.owner_id
            ? userById.get(roster.owner_id)
            : null;

          return (
            <li
              key={roster.roster_id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <div className="font-medium">
                  {owner?.display_name ?? "Unassigned Team"}
                </div>
                <div className="text-xs opacity-70">
                  Roster ID: {roster.roster_id}
                </div>
              </div>

              <div className="text-sm opacity-80">
                Players: {roster.players?.length ?? 0}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
