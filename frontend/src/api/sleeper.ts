// src/api/sleeper.ts
// Thin client wrapper around the Sleeper API via our frontend proxy:
// /api/sleeper/*  ->  https://api.sleeper.app/v1/*

export type SleeperUser = {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
};

export type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  total_rosters: number;
  status: string;
};

export type SleeperLeagueDetail = SleeperLeague & {
  sport: string;
  settings?: Record<string, any>;
  scoring_settings?: Record<string, any>;
  roster_positions?: string[];
};

export type SleeperLeagueUser = {
  user_id: string;
  display_name: string;
  avatar: string | null;
  metadata?: Record<string, any>;
};

export type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  co_owners?: string[];
  players?: string[];
  starters?: string[];
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
};

export type SleeperMatchup = {
  matchup_id: number;
  roster_id: number;
  points: number;
  starters?: string[];
  players?: string[];
  custom_points?: number;
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

/**
 * Fetch league details
 * GET /v1/league/{league_id}
 */
export const getSleeperLeague = (leagueId: string) =>
  sleeperFetch<SleeperLeagueDetail>(`league/${leagueId}`);

/**
 * Fetch league users (members)
 * GET /v1/league/{league_id}/users
 */
export const getSleeperLeagueUsers = (leagueId: string) =>
  sleeperFetch<SleeperLeagueUser[]>(`league/${leagueId}/users`);

/**
 * Fetch league rosters
 * GET /v1/league/{league_id}/rosters
 */
export const getSleeperRosters = (leagueId: string) =>
  sleeperFetch<SleeperRoster[]>(`league/${leagueId}/rosters`);

/**
 * Fetch weekly matchups for a league
 * GET /v1/league/{league_id}/matchups/{week}
 */
export const getSleeperMatchups = (leagueId: string, week: number) =>
  sleeperFetch<SleeperMatchup[]>(`league/${leagueId}/matchups/${week}`);
