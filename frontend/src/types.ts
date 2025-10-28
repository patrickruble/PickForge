// src/types.ts

export interface Game {
  id: string;
  commenceTime: string;           // ISO string (UTC kickoff)
  home: string;
  away: string;
  spreadHome: number | null;
  spreadAway: number | null;
  moneyline?: Record<string, number>; // team name -> odds value (American)
  source?: string;                 // e.g. "DraftKings"
  fetchedAt?: string;              // timestamp of data retrieval
}