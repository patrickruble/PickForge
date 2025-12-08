// src/types/bets.ts
export type BetStatus = "pending" | "won" | "lost" | "push" | "void";

export type BetRow = {
  id: string;
  user_id: string;
  sport: string;
  book_name: string | null;
  event_name: string;
  event_date: string | null; // ISO string from Supabase
  bet_type: string;
  selection: string;
  odds_american: number;
  stake: number;
  to_win: number;
  status: BetStatus;
  result_amount: number;
  created_at: string;
  updated_at: string;
};