import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  getSleeperLeague,
  getSleeperLeagueUsers,
  getSleeperRosters,
  type SleeperLeagueDetail,
  type SleeperLeagueUser,
  type SleeperRoster,
} from "../api/sleeper";

export default function SleeperLeague() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [league, setLeague] = useState<SleeperLeagueDetail | null>(null);
  const [users, setUsers] = useState<SleeperLeagueUser[]>([]);
  const [rosters, setRosters] = useState<SleeperRoster[]>([]);

  const [leagueId, setLeagueId] = useState<string | null>(null);

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

  const userById = useMemo(() => {
    const map = new Map<string, SleeperLeagueUser>();
    users.forEach((u) => map.set(u.user_id, u));
    return map;
  }, [users]);

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
