// src/api/sleeper.ts
// Thin client wrapper around the Sleeper API via our frontend proxy:
// /api/sleeper/*  ->  https://api.sleeper.app/v1/*

type SleeperUser = {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
};

type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  total_rosters: number;
  status: string;
};

const sleeperFetch = async <T>(path: string): Promise<T> => {
  const res = await fetch(`/api/sleeper/${path}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sleeper API ${res.status}: ${text}`);
  }

  return res.json();
};

/**
 * Fetch a Sleeper user by username
 * GET /v1/user/{username}
 */
export const getSleeperUser = (username: string) =>
  sleeperFetch<SleeperUser>(
    `user/${encodeURIComponent(username.trim())}`
  );

/**
 * Fetch all NFL leagues for a Sleeper user in a given season
 * GET /v1/user/{user_id}/leagues/nfl/{season}
 */
export const getSleeperLeagues = (
  userId: string,
  season: string = "2025"
) =>
  sleeperFetch<SleeperLeague[]>(
    `user/${userId}/leagues/nfl/${season}`
  );
