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

const CLOSE_MARGIN = 5; // points or fewer = close win/loss

type LuckStats = {
  actual: WLTTally;
  xw: number;
  luck: number;
};

type PowerRow = {
  roster_id: number;
  name: string;
  actual: WLTTally;
  xw: number;
  luck: number;
  median: WLTTally;
  combined: WLTTally;
  allplay: WLTTally;
  close: { cw: number; cl: number }; // close wins / close losses
  pf: number;
  sos: number | null;
};

type WeeklyGradeRow = {
  roster_id: number;
  name: string;
  points: number;
  result: string;
  vsMedian: string;
  grade: string;
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
  const [autoWeekLoaded, setAutoWeekLoaded] = useState(false);
  const [latestScoredWeek, setLatestScoredWeek] = useState<number | null>(null);
  const [matchupsLoading, setMatchupsLoading] = useState<boolean>(false);
  const [matchupsError, setMatchupsError] = useState<string | null>(null);
  const [matchups, setMatchups] = useState<SleeperMatchup[]>([]);

  const [medianRecLoading, setMedianRecLoading] = useState<boolean>(false);
  const [medianRecError, setMedianRecError] = useState<string | null>(null);
  const [medianRecordByRoster, setMedianRecordByRoster] = useState<
    Record<number, WLTTally>
  >({});

  const [luckByRoster, setLuckByRoster] = useState<Record<number, LuckStats>>({});
  const [powerRows, setPowerRows] = useState<PowerRow[]>([]);
  const [powerSortKey, setPowerSortKey] = useState<
    "xw" | "luck" | "pf" | "sos" | "actual" | "median" | "combined" | "allplay"
  >("xw");
  const [powerSortDir, setPowerSortDir] = useState<"asc" | "desc">("desc");

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
    const detectCurrentWeek = async () => {
      if (!leagueId || autoWeekLoaded) return;

      try {
        // Try weeks 1–18 and pick the latest week with any non-zero scoring.
        const weeks = Array.from({ length: 18 }, (_, i) => i + 1);
        const allWeekData = await Promise.all(
          weeks.map((w) => getSleeperMatchups(leagueId, w))
        );

        let bestWeek = 1;
        allWeekData.forEach((data, idx) => {
          if (!data || data.length === 0) return;
          const hasPoints = data.some(
            (m) => typeof m.points === "number" && m.points > 0
          );
          if (hasPoints) {
            bestWeek = weeks[idx];
          }
        });

        setWeek(bestWeek);
        setLatestScoredWeek(bestWeek);
      } catch {
        // If anything fails, just keep the default week = 1
      } finally {
        setAutoWeekLoaded(true);
      }
    };

    detectCurrentWeek();
  }, [leagueId, autoWeekLoaded]);

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

  const userById = useMemo(() => {
    const map = new Map<string, SleeperLeagueUser>();
    users.forEach((u) => map.set(u.user_id, u));
    return map;
  }, [users]);

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
        const pfAcc: Record<number, number> = {};
        const sosSumAcc: Record<number, number> = {};
        const sosCntAcc: Record<number, number> = {};
        const allPlayAcc: Record<number, WLTTally> = {};
        const closeAcc: Record<number, { cw: number; cl: number }> = {};

        weekDatas.forEach((weekMatchups) => {
          const pts = weekMatchups
            .map((m) => (typeof m.points === "number" ? m.points : 0))
            .filter((p) => Number.isFinite(p));

          // Skip unplayed weeks (commonly all zeros)
          const maxPts = pts.length ? Math.max(...pts) : 0;
          if (maxPts === 0) return;

          const med = median(pts);

          // Expected wins (xW): outscored/(teams-1) using weekly points rank
          const nTeams = weekMatchups.length;
          const rows = weekMatchups.map((m) => ({
            rid: m.roster_id,
            pts: typeof m.points === "number" ? m.points : 0,
            matchupId: m.matchup_id,
          }));

          // All-Play: vs every other roster this week
          for (let i = 0; i < rows.length; i++) {
            const a = rows[i];
            if (!allPlayAcc[a.rid]) allPlayAcc[a.rid] = { w: 0, l: 0, t: 0 };
            for (let j = 0; j < rows.length; j++) {
              if (i === j) continue;
              const b = rows[j];
              if (a.pts > b.pts) allPlayAcc[a.rid].w += 1;
              else if (a.pts < b.pts) allPlayAcc[a.rid].l += 1;
              else allPlayAcc[a.rid].t += 1;
            }
          }

          // PF accumulation
          rows.forEach((r) => {
            pfAcc[r.rid] = (pfAcc[r.rid] ?? 0) + r.pts;
          });

          // SoS accumulation: average opponent points faced (head-to-head only)
          const byMatchup2 = new Map<number, Array<{ rid: number; pts: number }>>();
          rows.forEach((r) => {
            const mid = r.matchupId;
            if (typeof mid !== "number") return;
            const arr = byMatchup2.get(mid) ?? [];
            arr.push({ rid: r.rid, pts: r.pts });
            byMatchup2.set(mid, arr);
          });

          byMatchup2.forEach((pair) => {
            if (pair.length < 2) return;
            const a = pair[0];
            const b = pair[1];
            sosSumAcc[a.rid] = (sosSumAcc[a.rid] ?? 0) + b.pts;
            sosCntAcc[a.rid] = (sosCntAcc[a.rid] ?? 0) + 1;
            sosSumAcc[b.rid] = (sosSumAcc[b.rid] ?? 0) + a.pts;
            sosCntAcc[b.rid] = (sosCntAcc[b.rid] ?? 0) + 1;
          });

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

            if (!closeAcc[a.rid]) closeAcc[a.rid] = { cw: 0, cl: 0 };
            if (!closeAcc[b.rid]) closeAcc[b.rid] = { cw: 0, cl: 0 };

            const margin = Math.abs(a.pts - b.pts);
            const isClose = margin > 0 && margin <= CLOSE_MARGIN;

            if (a.pts > b.pts) {
              actualAcc[a.rid].w += 1;
              actualAcc[b.rid].l += 1;
              if (isClose) {
                closeAcc[a.rid].cw += 1;
                closeAcc[b.rid].cl += 1;
              }
            } else if (a.pts < b.pts) {
              actualAcc[a.rid].l += 1;
              actualAcc[b.rid].w += 1;
              if (isClose) {
                closeAcc[a.rid].cl += 1;
                closeAcc[b.rid].cw += 1;
              }
            } else {
              actualAcc[a.rid].t += 1;
              actualAcc[b.rid].t += 1;
              // ties (margin 0) are not counted as close wins/losses
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

        const rowsOut: PowerRow[] = rosters.map((r) => {
          const rid = r.roster_id;
          const owner = r.owner_id ? userById.get(r.owner_id) : null;
          const name = owner?.display_name ?? `Roster ${rid}`;

          const actual = actualAcc[rid] ?? { w: 0, l: 0, t: 0 };
          const xw = xwAcc[rid] ?? 0;
          const actualWins = actual.w + 0.5 * actual.t;
          const luckVal = actualWins - xw;
          const medRec = acc[rid] ?? { w: 0, l: 0, t: 0 };
          const combined: WLTTally = {
            w: actual.w + medRec.w,
            l: actual.l + medRec.l,
            t: actual.t + medRec.t,
          };
          const allplay: WLTTally = allPlayAcc[rid] ?? { w: 0, l: 0, t: 0 };
          const close = closeAcc[rid] ?? { cw: 0, cl: 0 };
          const pf = pfAcc[rid] ?? 0;
          const sos = sosCntAcc[rid]
            ? (sosSumAcc[rid] ?? 0) / sosCntAcc[rid]
            : null;

          return {
            roster_id: rid,
            name,
            actual,
            xw,
            luck: luckVal,
            median: medRec,
            combined,
            allplay,
            close,
            pf,
            sos,
          };
        });

        // Sort by expected wins then PF as tie-breaker
        rowsOut.sort((a, b) => {
          if (b.xw !== a.xw) return b.xw - a.xw;
          return b.pf - a.pf;
        });

        setPowerRows(rowsOut);
      } catch (e: any) {
        setMedianRecError(e?.message ?? "Failed to compute median records.");
        setMedianRecordByRoster({});
        setLuckByRoster({});
        setPowerRows([]);
      } finally {
        setMedianRecLoading(false);
      }
    };

    loadMedianRecords();
  }, [leagueId, week, rosters, userById]);


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

  const wltWins = (t?: WLTTally) => {
    if (!t) return 0;
    return t.w + 0.5 * t.t;
  };

  const weeklyGrades = useMemo<WeeklyGradeRow[]>(() => {
    if (!matchups.length) return [];

    type TmpRow = {
      roster_id: number;
      points: number;
      matchup_id: number | null;
    };

    const rows: TmpRow[] = matchups.map((m) => ({
      roster_id: m.roster_id,
      points: typeof m.points === "number" ? m.points : 0,
      matchup_id: typeof m.matchup_id === "number" ? m.matchup_id : null,
    }));

    // Rank teams by points for percentile-based grading
    const sortedByPts = [...rows].sort((a, b) => b.points - a.points);
    const n = sortedByPts.length || 1;
    const rankByRoster: Record<number, number> = {};
    sortedByPts.forEach((r, idx) => {
      rankByRoster[r.roster_id] = idx;
    });

    const gradeFromPct = (pct: number) => {
      if (pct >= 0.9) return "A+";
      if (pct >= 0.8) return "A";
      if (pct >= 0.7) return "B+";
      if (pct >= 0.6) return "B";
      if (pct >= 0.5) return "C+";
      if (pct >= 0.4) return "C";
      if (pct >= 0.3) return "D+";
      if (pct >= 0.2) return "D";
      return "F";
    };

    // Map of roster_id -> opponent points for this week (if any)
    const matchupMap = new Map<number, TmpRow[]>();
    rows.forEach((r) => {
      if (r.matchup_id === null) return;
      const group = matchupMap.get(r.matchup_id) ?? [];
      group.push(r);
      matchupMap.set(r.matchup_id, group);
    });

    const opponentPts: Record<number, number | null> = {};
    matchupMap.forEach((group) => {
      if (group.length < 2) {
        group.forEach((r) => {
          if (opponentPts[r.roster_id] === undefined) {
            opponentPts[r.roster_id] = null;
          }
        });
        return;
      }
      const [a, b] = group;
      opponentPts[a.roster_id] = b.points;
      opponentPts[b.roster_id] = a.points;
    });

    const out: WeeklyGradeRow[] = rows.map((r) => {
      const name =
        rosterNameById.get(r.roster_id) ?? `Roster ${r.roster_id}`;

      const rank = rankByRoster[r.roster_id] ?? 0;
      const pct = n > 1 ? 1 - rank / (n - 1) : 1;
      const grade = gradeFromPct(pct);

      const opp = opponentPts[r.roster_id] ?? null;
      let result = "-";
      if (opp !== null) {
        if (r.points > opp) result = "W";
        else if (r.points < opp) result = "L";
        else result = "T";
      }

      let vsMedian = "-";
      if (weekMedian !== null) {
        if (r.points > weekMedian) vsMedian = "Above";
        else if (r.points < weekMedian) vsMedian = "Below";
        else vsMedian = "At";
      }

      return {
        roster_id: r.roster_id,
        name,
        points: r.points,
        result,
        vsMedian,
        grade,
      };
    });

    // Sort grades by points scored this week, descending
    out.sort((a, b) => b.points - a.points);

    return out;
  }, [matchups, rosterNameById, weekMedian]);


  const medianStandings = useMemo(() => {
    const rows = rosters.map((r) => {
      const rid = r.roster_id;
      const name = rosterNameById.get(rid) ?? `Roster ${rid}`;
      const med = medianRecordByRoster[rid] ?? { w: 0, l: 0, t: 0 };
      const wins = wltWins(med);
      const games = med.w + med.l + med.t;
      const pct = games > 0 ? wins / games : 0;
      const pf = powerRows.find((p) => p.roster_id === rid)?.pf ?? 0;
      return { roster_id: rid, name, med, wins, games, pct, pf };
    });

    rows.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      // tie-breakers: win% then PF
      if (b.pct !== a.pct) return b.pct - a.pct;
      return b.pf - a.pf;
    });

    return rows;
  }, [rosters, rosterNameById, medianRecordByRoster, powerRows]);

  const sortedPowerRows = useMemo(() => {
    const rows = [...powerRows];

    const valueFor = (r: PowerRow) => {
      switch (powerSortKey) {
        case "xw":
          return r.xw;
        case "luck":
          return r.luck;
        case "pf":
          return r.pf;
        case "sos":
          // put nulls at the end
          return r.sos === null ? (powerSortDir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : r.sos;
        case "actual":
          return wltWins(r.actual);
        case "median":
          return wltWins(r.median);
        case "combined":
          return wltWins(r.combined);
        case "allplay":
          return wltWins(r.allplay);
        default:
          return r.xw;
      }
    };

    rows.sort((a, b) => {
      const av = valueFor(a);
      const bv = valueFor(b);
      if (av === bv) {
        // tie-breakers: xW then PF
        if (b.xw !== a.xw) return b.xw - a.xw;
        return b.pf - a.pf;
      }
      return powerSortDir === "asc" ? av - bv : bv - av;
    });

    return rows;
  }, [powerRows, powerSortKey, powerSortDir]);

  const onSort = (
    key: "xw" | "luck" | "pf" | "sos" | "actual" | "median" | "combined" | "allplay"
  ) => {
    if (powerSortKey === key) {
      setPowerSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setPowerSortKey(key);
      setPowerSortDir("desc");
    }
  };

  const sortIndicator = (
    key: "xw" | "luck" | "pf" | "sos" | "actual" | "median" | "combined" | "allplay"
  ) => {
    if (powerSortKey !== key) return "";
    return powerSortDir === "asc" ? " ▲" : " ▼";
  };

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
      <div className="mb-8 rounded-lg border p-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Median Standings</h2>
            <p className="text-xs opacity-70">
              Standings if each week you played the league median (above median = win, below = loss).
            </p>
          </div>
        </div>

        {medianRecLoading ? (
          <div className="text-sm opacity-80">Computing median standings…</div>
        ) : medianStandings.length === 0 ? (
          <div className="text-sm opacity-80">No median data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs opacity-70">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Team</th>
                  <th className="py-2 pr-2">Median</th>
                  <th className="py-2 pr-2" title="Median win percentage">Med %</th>
                  <th className="py-2" title="Points for (tie-breaker)">PF</th>
                </tr>
              </thead>
              <tbody>
                {medianStandings.map((r, i) => (
                  <tr key={r.roster_id} className="border-t border-white/10">
                    <td className="py-2 pr-2 tabular-nums opacity-80">{i + 1}</td>
                    <td className="py-2 pr-2 font-medium">{r.name}</td>
                    <td className="py-2 pr-2 tabular-nums">{tallyToString(r.med)}</td>
                    <td className="py-2 pr-2 tabular-nums">{(r.pct * 100).toFixed(1)}%</td>
                    <td className="py-2 tabular-nums">{r.pf.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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

        {!matchupsLoading &&
          !matchupsError &&
          weeklyGrades.length > 0 &&
          latestScoredWeek !== null &&
          week < latestScoredWeek && (
          <div className="mt-6 border-t pt-4">
            <h3 className="mb-2 text-sm font-semibold">Weekly Grades</h3>
            <p className="mb-2 text-xs opacity-70">
              Grades are based on this week's points compared to the rest of the league.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left opacity-70">
                  <tr>
                    <th className="py-1 pr-2">#</th>
                    <th className="py-1 pr-2">Team</th>
                    <th className="py-1 pr-2">Pts</th>
                    <th className="py-1 pr-2">Result</th>
                    <th className="py-1 pr-2">Vs median</th>
                    <th className="py-1">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyGrades.map((row, idx) => (
                    <tr
                      key={row.roster_id}
                      className="border-t border-white/10"
                    >
                      <td className="py-1 pr-2 tabular-nums opacity-80">
                        {idx + 1}
                      </td>
                      <td className="py-1 pr-2 truncate">{row.name}</td>
                      <td className="py-1 pr-2 tabular-nums">
                        {row.points.toFixed(1)}
                      </td>
                      <td className="py-1 pr-2 tabular-nums">{row.result}</td>
                      <td className="py-1 pr-2">{row.vsMedian}</td>
                      <td className="py-1 tabular-nums font-semibold">
                        {row.grade}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="mb-8 rounded-lg border p-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Power Rankings</h2>
            <p className="text-xs opacity-70">
              Sorted by expected wins (xW). Luck shows actual − xW. SoS is average opponent points faced. Close (W/L) are games decided by ≤{CLOSE_MARGIN} pts.
            </p>
          </div>
        </div>

        {medianRecLoading ? (
          <div className="text-sm opacity-80">Computing rankings…</div>
        ) : powerRows.length === 0 ? (
          <div className="text-sm opacity-80">No ranking data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs opacity-70">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Team</th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("actual")}
                      className="hover:underline"
                      title="Sort by actual record (wins + 0.5 ties)"
                    >
                      Actual{sortIndicator("actual")}
                    </button>
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("xw")}
                      className="hover:underline"
                      title="Sort by expected wins"
                    >
                      xW{sortIndicator("xw")}
                    </button>
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("luck")}
                      className="hover:underline"
                      title="Sort by luck (actual − xW)"
                    >
                      Luck{sortIndicator("luck")}
                    </button>
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("median")}
                      className="hover:underline"
                      title="Sort by median record (wins + 0.5 ties)"
                    >
                      Median{sortIndicator("median")}
                    </button>
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("combined")}
                      className="hover:underline"
                      title="Sort by combined record (matchup + median)"
                    >
                      Combined{sortIndicator("combined")}
                    </button>
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("allplay")}
                      className="hover:underline"
                      title="Sort by all-play record (vs everyone each week)"
                    >
                      All-Play{sortIndicator("allplay")}
                    </button>
                  </th>
                  <th className="py-2 pr-2" title={`Games decided by ≤${CLOSE_MARGIN} pts`}>
                    Close (W/L)
                  </th>
                  <th className="py-2 pr-2">
                    <button
                      type="button"
                      onClick={() => onSort("pf")}
                      className="hover:underline"
                      title="Sort by points for"
                    >
                      PF{sortIndicator("pf")}
                    </button>
                  </th>
                  <th className="py-2">
                    <button
                      type="button"
                      onClick={() => onSort("sos")}
                      className="hover:underline"
                      title="Sort by strength of schedule (avg opponent points)"
                    >
                      SoS{sortIndicator("sos")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedPowerRows.map((r, i) => (
                  <tr key={r.roster_id} className="border-t border-white/10">
                    <td className="py-2 pr-2 tabular-nums opacity-80">{i + 1}</td>
                    <td className="py-2 pr-2 font-medium">{r.name}</td>
                    <td className="py-2 pr-2 tabular-nums">{tallyToString(r.actual)}</td>
                    <td className="py-2 pr-2 tabular-nums">{r.xw.toFixed(1)}</td>
                    <td className="py-2 pr-2 tabular-nums">
                      <span
                        className={
                          r.luck > 0.5
                            ? "rounded bg-green-600/15 px-2 py-0.5 text-xs text-green-200"
                            : r.luck < -0.5
                            ? "rounded bg-red-600/15 px-2 py-0.5 text-xs text-red-200"
                            : "rounded bg-slate-500/15 px-2 py-0.5 text-xs text-slate-200"
                        }
                        title="Luck = (actual wins + 0.5 ties) − expected wins"
                      >
                        {formatSigned(r.luck)}
                      </span>
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{tallyToString(r.median)}</td>
                    <td className="py-2 pr-2 tabular-nums">{tallyToString(r.combined)}</td>
                    <td className="py-2 pr-2 tabular-nums">{tallyToString(r.allplay)}</td>
                    <td className="py-2 pr-2 tabular-nums">
                      {r.close.cw}-{r.close.cl}
                    </td>
                    <td className="py-2 pr-2 tabular-nums">{r.pf.toFixed(1)}</td>
                    <td className="py-2 tabular-nums">
                      {r.sos === null ? "—" : r.sos.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}