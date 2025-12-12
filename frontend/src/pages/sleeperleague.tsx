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
        </div>

        {matchupsLoading && (
          <div className="text-sm opacity-80">Loading matchups…</div>
        )}
        {matchupsError && (
          <div className="text-sm text-red-500">{matchupsError}</div>
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
                    <div className="font-medium">
                      {aName} <span className="opacity-70">({aPts})</span>
                    </div>
                    <div className="text-xs opacity-70">Awaiting opponent</div>
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
                      <div className="text-xs opacity-70">
                        Roster {a.roster_id}
                      </div>
                    </div>

                    <div className="shrink-0 text-base font-semibold tabular-nums">
                      {aPts} — {bPts}
                    </div>

                    <div className="min-w-0 text-right">
                      <div className="truncate font-medium">{bName}</div>
                      <div className="text-xs opacity-70">
                        Roster {b.roster_id}
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
