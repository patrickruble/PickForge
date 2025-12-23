export type MarketType =
  | "moneyline"
  | "spread"
  | "total"          // game total (over/under)
  | "team_total"
  | "player_prop"
  | "game_prop"
  | "first_td"
  | "anytime_td"
  | "alt_line"       // alt spread/total/team total
  | "future"
  | "other";

export type SideType =
  | "home"
  | "away"
  | "over"
  | "under"
  | "yes"
  | "no"
  | "player"        // props where “side” is essentially the player
  | null;

export type ParsedSlip = {
  book?: string | null;
  ticket_no?: string | null;
  placed_at?: string | null; // ISO string

  wager?: number | null;
  to_win?: number | null;
  odds_american?: number | null;
  currency?: "USD" | string | null;

  // Optional: slip-level structure (offshore often has "3 leg parlay", etc.)
  bet_style?: "single" | "parlay" | "round_robin" | "teaser" | "unknown" | null;
  legs_count?: number | null;

  bets: Array<{
    kind: "single" | "parlay_leg";

    sport?: string | null;   // "Football", "Basketball"
    league?: string | null;  // "NFL", "NCAAF", "NBA"
    event?: string | null;   // "Rams @ Seahawks"
    event_date?: string | null; // ISO
    home_team?: string | null;
    away_team?: string | null;

    // ✅ Normalized classification (what you asked for)
    market_type: MarketType;

    // ✅ Keep the raw text too (for offshore weirdness)
    market_text?: string | null;     // "Player Props Plus" / "1st Half" / etc
    selection_text: string;          // full human-readable selection as seen on slip

    // Useful structured fields when available
    player?: string | null;          // "Christian McCaffrey"
    stat?: string | null;            // "Receiving Yards", "Interceptions", "Receptions"
    period?: string | null;          // "Game", "1H", "Q1", etc
    line?: number | null;            // 40.5, -1.5, etc
    side?: SideType;                 // over/under/home/away/yes/no/etc
    team?: string | null;            // for team totals / team props

    odds_american?: number | null;

    // Flags
    is_alt?: boolean | null;         // alt spread/total/team total
    is_live?: boolean | null;        // live bet if detected

    confidence: number;              // 0..1
    issues?: string[];
  }>;

  meta?: {
    parser_version: string;
    source: "stub" | "ocr" | "ai";
  };
};