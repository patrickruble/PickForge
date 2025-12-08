// src/lib/pickGrading.ts

// Shared types so this file does not depend on Stats.tsx or Leaderboard.tsx
export type League = "nfl" | "ncaaf";

export type GameRow = {
  id: string;
  week: number;
  league: League;
  home_team: string;
  away_team: string;
  status: string | null;
  home_score: number | null;
  away_score: number | null;
};

export type PickRow = {
  id?: string;
  user_id: string;
  league: League;
  week: number;
  game_id: string;
  side: "home" | "away";
  picked_price_type: "ml" | "spread" | null;
  picked_price: number | null;
};

export type PickWithGame = PickRow & {
  game: GameRow | null;
};

export type Grade = "pending" | "win" | "loss" | "push";

// ----------------------------------------------------------
// helper: isFinalStatus
// ----------------------------------------------------------
function isFinalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();

  // very common variants
  if (s === "final") return true;
  if (s === "finished" || s === "complete" || s === "completed") return true;
  if (s === "closed" || s === "ended") return true;

  // things like "final_ot", "final overtime", etc.
  if (s.startsWith("final")) return true;

  return false;
}

// ----------------------------------------------------------
// gradePick
// ----------------------------------------------------------
export function gradePick(row: PickWithGame): Grade {
  const game = row.game;
  if (!game || !isFinalStatus(game.status)) return "pending";

  const home = game.home_score ?? null;
  const away = game.away_score ?? null;
  if (home == null || away == null) return "pending";

  const pickedScore = row.side === "home" ? home : away;
  const otherScore = row.side === "home" ? away : home;

  // ML → straight winner
  if (row.picked_price_type === "ml" || row.picked_price == null) {
    if (pickedScore > otherScore) return "win";
    if (pickedScore < otherScore) return "loss";
    return "push";
  }

  // Spread
  const spread = row.picked_price;
  const diff = pickedScore + spread - otherScore;

  if (diff > 0) return "win";
  if (diff < 0) return "loss";
  return "push";
}

// ----------------------------------------------------------
// classifyDogFav
// ----------------------------------------------------------
export function classifyDogFav(
  p: PickRow
): "underdog" | "favorite" | "even" | "unknown" {
  if (p.picked_price == null || !p.picked_price_type) return "unknown";

  if (p.picked_price_type === "spread") {
    if (p.picked_price > 0) return "underdog";
    if (p.picked_price < 0) return "favorite";
    return "even";
  }

  if (p.picked_price_type === "ml") {
    if (p.picked_price > 0) return "underdog";
    if (p.picked_price < 0) return "favorite";
  }

  return "unknown";
}

// ----------------------------------------------------------
// formatLine
// ----------------------------------------------------------
export function formatLine(p: PickRow): string {
  if (!p.picked_price_type || p.picked_price == null) return "-";

  const v = p.picked_price;
  return v > 0 ? `+${v}` : `${v}`;
}