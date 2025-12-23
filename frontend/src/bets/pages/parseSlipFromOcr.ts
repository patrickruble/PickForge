import type { ParsedSlip, MarketType, SideType } from "./types/parsedSlip";

export type ParseSlipOptions = {
  bookHint?: string | null;
};

function toNumberMaybe(raw: string): number | null {
  const cleaned = raw.replace(/[,]/g, "").replace(/\$/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectMarketType(line: string): MarketType {
  const s = line.toLowerCase();

  if (s.includes("moneyline") || /\bml\b/.test(s)) return "moneyline";
  if (s.includes("spread") || /\b-\d+(\.\d+)?\b/.test(s)) return "spread";
  if (s.includes("over") || s.includes("under") || s.includes("total")) return "total";
  if (s.includes("team total")) return "team_total";
  if (s.includes("first td") || s.includes("first touchdown")) return "first_td";
  if (s.includes("anytime td") || s.includes("anytime touchdown")) return "anytime_td";
  if (s.includes("alt")) return "alt_line";
  if (s.includes("future")) return "future";
  if (s.includes("game prop")) return "game_prop";
  if (s.includes("prop")) return "player_prop";

  return "other";
}

function detectSide(line: string): SideType {
  const s = line.toLowerCase();
  if (s.includes(" over ") || s.endsWith(" over") || /\bover\b/.test(s)) return "over";
  if (s.includes(" under ") || s.endsWith(" under") || /\bunder\b/.test(s)) return "under";
  if (s.includes(" yes") || /\byes\b/.test(s)) return "yes";
  if (s.includes(" no") || /\bno\b/.test(s)) return "no";
  return null;
}

/**
 * Best-effort OCR parser.
 * Phase 1 goal: return a stable ParsedSlip shape (even if most fields are null)
 * so the Review UI can render editable rows.
 */
export function parseSlipFromOcr(ocrText: string, opts: ParseSlipOptions = {}): ParsedSlip {
  const text = (ocrText ?? "").replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const parlayHint = lines.some(
    (l) => /\bparlay\b/i.test(l) || /\bleg\s+parlay\b/i.test(l) || /view\s+legs/i.test(l)
  );

  // Try to extract legs count if present (e.g., "3 LEG PARLAY")
  const legsCountFromText = (() => {
    const m = lines.join(" ").match(/(\d+)\s*leg\s*parlay/i);
    return m ? Number(m[1]) : null;
  })();

  // Slip-level amounts
  const wagerLine = lines.find((l) => /\bwager\b/i.test(l));
  const returnLine = lines.find((l) => /\breturn\b/i.test(l) || /\bto win\b/i.test(l));
  const oddsLine = lines.find((l) => /\bodds\b/i.test(l));

  const wager = wagerLine ? toNumberMaybe(wagerLine.split(/wager\s*:?/i).pop() ?? "") : null;
  const to_win = returnLine
    ? toNumberMaybe(
        (
          returnLine.split(/return\s*:?/i).pop() ??
          returnLine.split(/to win\s*:?/i).pop() ??
          ""
        ).trim()
      )
    : null;

  // Odds might look like "+237" / "-110" on the slip
  const oddsMatch = oddsLine?.match(/([+-]\d{2,5})/);
  const odds_american = oddsMatch ? Number(oddsMatch[1]) : null;

  // Parse bet lines (very conservative): take lines that look like selections.
  const betLines = lines.filter((l) => {
    const s = l.toLowerCase();
    if (s.startsWith("odds")) return false;
    if (s.startsWith("wager")) return false;
    if (s.startsWith("return")) return false;
    if (s.includes("successfully submitted")) return false;
    if (s.includes("leg parlay")) return false;
    return /\b(over|under)\b/i.test(l) || /\bto record\b/i.test(l) || /\b@\b/.test(l) || /[+-]\d{2,5}/.test(l);
  });

  // If this is a parlay slip, we want ONE bet row in the UI (not one per leg).
  const bets: ParsedSlip["bets"] = (() => {
    if (parlayHint && betLines.length > 1) {
      const combined = betLines.join(" | ");

      const legTypes = betLines.map((l) => detectMarketType(l));
      const unique = Array.from(new Set(legTypes));

      const parlayMarket: MarketType = (() => {
        if (unique.length === 1) {
          switch (unique[0]) {
            case "moneyline":
              return "moneyline_parlay";
            case "spread":
              return "spread_parlay";
            case "total":
              return "total_parlay";
            case "team_total":
              return "team_total_parlay";
            case "player_prop":
              return "player_prop_parlay";
            case "game_prop":
              return "game_prop_parlay";
            case "first_td":
              return "first_td_parlay";
            case "anytime_td":
              return "anytime_td_parlay";
            case "alt_line":
              return "alt_line_parlay";
            default:
              return "parlay";
          }
        }

        if (unique.includes("alt_line")) return "alt_line_parlay";
        return "parlay";
      })();

      return [
        {
          kind: "single",
          sport: null,
          league: null,
          event: null,
          event_date: null,
          home_team: null,
          away_team: null,
          market_type: parlayMarket,
          market_text: null,
          selection_text: combined,
          player: null,
          stat: null,
          period: null,
          line: null,
          side: null,
          team: null,
          odds_american: odds_american ?? null,
          is_alt: parlayMarket === "alt_line_parlay" ? true : null,
          is_live: null,
          confidence: 0.4,
          issues: ["parlay_detected", "needs_review"],
        },
      ];
    }

    return betLines.map((line) => {
      const market_type = detectMarketType(line);
      const side = detectSide(line);

      const om = line.match(/(?:@\s*)?([+-]\d{2,5})\b/);
      const lineOdds = om ? Number(om[1]) : null;

      return {
        kind: betLines.length > 1 ? "parlay_leg" : "single",
        sport: null,
        league: null,
        event: null,
        event_date: null,
        home_team: null,
        away_team: null,
        market_type,
        market_text: null,
        selection_text: line,
        player: null,
        stat: null,
        period: null,
        line: null,
        side,
        team: null,
        odds_american: lineOdds,
        is_alt: market_type === "alt_line" ? true : null,
        is_live: null,
        confidence: 0.4,
        issues: ["needs_review"],
      };
    });
  })();

  const parsed: ParsedSlip = {
    book: opts.bookHint ?? null,
    ticket_no: null,
    placed_at: null,
    wager: wager ?? null,
    to_win: to_win ?? null,
    odds_american: odds_american ?? null,
    currency: "USD",
    bet_style: parlayHint && betLines.length > 1 ? "parlay" : bets.length === 1 ? "single" : "unknown",
    legs_count: parlayHint && betLines.length > 1 ? legsCountFromText ?? betLines.length : bets.length || null,
    bets,
    meta: {
      parser_version: "dev",
      source: "ocr",
    },
  };

  return parsed;
}

export default parseSlipFromOcr;
