import { useMemo, useState } from "react";
import { getSleeperLeagues, getSleeperUser } from "../api/sleeper";
import { supabase } from "../lib/supabase";

export default function ConnectSleeper() {
  const [username, setUsername] = useState<string>("");
  const [season, setSeason] = useState<string>("2025");

  const [loading, setLoading] = useState(false);
  const [savingLeagueId, setSavingLeagueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [sleeperUser, setSleeperUser] = useState<
    | {
        user_id: string;
        username: string;
        display_name: string;
        avatar: string | null;
      }
    | null
  >(null);

  const [leagues, setLeagues] = useState<
    Array<{
      league_id: string;
      name: string;
      season: string;
      total_rosters: number;
      status: string;
    }>
  >([]);

  const canSearch = useMemo(() => username.trim().length >= 2, [username]);

  const handleLookup = async () => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(null);
      setLeagues([]);
      setSleeperUser(null);

      const u = await getSleeperUser(username);
      setSleeperUser(u);

      const l = await getSleeperLeagues(u.user_id, season);
      setLeagues(l);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Sleeper data.");
    } finally {
      setLoading(false);
    }
  };

  const saveLeague = async (leagueId: string) => {
    try {
      if (!sleeperUser) return;

      setSavingLeagueId(leagueId);
      setError(null);
      setSuccess(null);

      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser();

      if (authErr) throw authErr;
      if (!user) throw new Error("You must be logged in to connect Sleeper.");

      const { error: updateErr } = await supabase
        .from("profiles")
        .update({
          sleeper_username: sleeperUser.username,
          sleeper_user_id: sleeperUser.user_id,
          sleeper_league_id: leagueId,
          sleeper_season: season,
        })
        .eq("id", user.id);

      if (updateErr) throw updateErr;

      setSuccess("Sleeper connected. League saved.");
    } catch (e: any) {
      setError(e?.message ?? "Failed to save Sleeper league.");
    } finally {
      setSavingLeagueId(null);
    }
  };

  const avatarUrl = useMemo(() => {
    if (!sleeperUser?.avatar) return null;
    return `https://sleepercdn.com/avatars/${sleeperUser.avatar}`;
  }, [sleeperUser?.avatar]);

  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Connect Sleeper</h1>
        <p className="text-sm opacity-80">
          Link your Sleeper account to pull leagues (matchups later).
        </p>
      </div>

      <div className="rounded-lg border p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
          <div>
            <label htmlFor="sleeper-username" className="mb-1 block text-sm font-medium">Sleeper username</label>
            <input
              id="sleeper-username"
              className="w-full rounded border bg-transparent p-2"
              placeholder="e.g. patrickruble"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div>
            <label htmlFor="sleeper-season" className="mb-1 block text-sm font-medium">Season</label>
            <input
              id="sleeper-season"
              className="w-full rounded border bg-transparent p-2"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="2025"
              title="Season (e.g. 2025)"
            />
          </div>

          <div className="flex items-end">
            <button
              className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-60"
              onClick={handleLookup}
              disabled={!canSearch || loading}
              type="button"
            >
              {loading ? "Loading…" : "Find leagues"}
            </button>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {success && <p className="mt-3 text-sm text-green-600">{success}</p>}

        {sleeperUser && (
          <div className="mt-4 flex items-center gap-3 rounded border p-3">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Sleeper avatar"
                className="h-10 w-10 rounded-full"
              />
            ) : (
              <div className="h-10 w-10 rounded-full border" />
            )}

            <div>
              <div className="font-semibold">
                {sleeperUser.display_name} <span className="opacity-70">(@{sleeperUser.username})</span>
              </div>
              <div className="text-xs opacity-70">User ID: {sleeperUser.user_id}</div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-lg font-semibold">Leagues</h2>

        {sleeperUser && leagues.length === 0 && !loading && !error && (
          <p className="text-sm opacity-80">
            No leagues found for {season}. Try a different season.
          </p>
        )}

        {leagues.length > 0 && (
          <ul className="space-y-2">
            {leagues.map((lg) => (
              <li
                key={lg.league_id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div>
                  <div className="font-medium">{lg.name}</div>
                  <div className="text-xs opacity-70">
                    Season: {lg.season} • Teams: {lg.total_rosters} • Status: {lg.status}
                  </div>
                </div>

                <button
                  className="rounded bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-60"
                  type="button"
                  onClick={() => saveLeague(lg.league_id)}
                  disabled={savingLeagueId === lg.league_id}
                >
                  {savingLeagueId === lg.league_id ? "Saving…" : "Select"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
