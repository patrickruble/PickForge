// --- Google Vision annotation helpers ---
type VisionVertex = { x?: number; y?: number };
type VisionPoly = { vertices?: VisionVertex[] };
type VisionAnn = { description?: string; boundingPoly?: VisionPoly };

type OcrInput =
  | string
  | {
      text?: string;
      annotations?: VisionAnn[];
      textAnnotations?: VisionAnn[];
    };


function getTextAndAnnotations(input: OcrInput): { text: string; annotations: VisionAnn[] } {
  if (typeof input === "string") return { text: input, annotations: [] };
  const text = (input?.text ?? "") as string;
  const annotations = (input?.annotations ?? input?.textAnnotations ?? []) as VisionAnn[];
  return { text, annotations };
}

function stripDebugLines(text: string): string {
  if (!text) return text;
  const lines = text.split(/\r?\n/);

  // Drop any debug section your ReviewSlip page may append.
  // We treat any line that starts with "---" and contains "debug" (case-insensitive)
  // as the start of a debug block, and we drop that line plus subsequent non-empty lines
  // until we hit a blank line.
  const out: string[] = [];
  let skipping = false;

  for (const l of lines) {
    const s = l ?? "";
    const low = s.trim().toLowerCase();

    if (!skipping && low.startsWith("---") && low.includes("debug")) {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (!low) {
        skipping = false;
      }
      continue;
    }

    // Also drop single-line debug prefixes that sometimes leak into OCR text.
    if (low.startsWith("[reviewslip]") || low.startsWith("debug:")) continue;

    out.push(s);
  }

  return out.join("\n");
}

function centerOf(poly?: VisionPoly): { x: number; y: number } {
  const v = poly?.vertices ?? [];
  if (!v.length) return { x: 0, y: 0 };
  const xs = v.map((p) => p.x ?? 0);
  const ys = v.map((p) => p.y ?? 0);
  return {
    x: xs.reduce((a, b) => a + b, 0) / xs.length,
    y: ys.reduce((a, b) => a + b, 0) / ys.length,
  };
}

function buildDollarAmountsFromVision(annotations: VisionAnn[]): Array<{ value: number; x: number; y: number }> {
  // Vision textAnnotations[0] is often the full-page blob; skip it.
  const anns = Array.isArray(annotations) ? annotations.slice(1) : [];

  const dollars = anns
    .filter((a) => (a.description ?? "").trim() === "$")
    .map((a) => ({ a, c: centerOf(a.boundingPoly) }))
    .filter((x) => x.c.x > 0 && x.c.y > 0);

  const nums = anns
    .filter((a) => /^\d{1,5}(?:\.\d{1,2})?$/.test((a.description ?? "").trim()))
    .map((a) => ({ a, c: centerOf(a.boundingPoly) }))
    .filter((x) => x.c.x > 0 && x.c.y > 0);

  const out: Array<{ value: number; x: number; y: number }> = [];

  // 1) Preferred path: pair a '$' with the nearest number to the right on the same visual row.
  for (const d of dollars) {
    const cand = nums
      .filter((n) => Math.abs(n.c.y - d.c.y) < 35 && n.c.x > d.c.x && n.c.x - d.c.x < 220)
      .sort((p, q) => (p.c.x - d.c.x) - (q.c.x - d.c.x))[0];

    if (!cand) continue;
    const val = Number((cand.a.description ?? "").trim());
    if (!Number.isFinite(val)) continue;

    out.push({ value: val, x: cand.c.x, y: cand.c.y });
  }

  if (out.length) return out;

  // 2) Fallback: Vision sometimes misses the '$' when amounts are red.
  // Use standalone numbers as amount candidates, but avoid ticket numbers.
  // Heuristics:
  // - Ignore very large numbers (ticket numbers are 6–12 digits; amounts are usually small)
  // - Keep only values in a reasonable money range
  const fallback = nums
    .map((n) => ({
      value: Number((n.a.description ?? "").trim()),
      x: n.c.x,
      y: n.c.y,
      raw: (n.a.description ?? "").trim(),
    }))
    .filter((n) => Number.isFinite(n.value))
    // Ignore likely ticket numbers (6+ digits without decimals)
    .filter((n) => !( /^\d{6,}$/.test(n.raw) ))
    // Keep plausible money values (tune if needed)
    .filter((n) => n.value > 0 && n.value <= 10000);

  return fallback.map(({ value, x, y }) => ({ value, x, y }));
}

function findWordCenterX(annotations: VisionAnn[], word: string): number | null {
  const target = word.trim().toLowerCase();
  const anns = Array.isArray(annotations) ? annotations.slice(1) : [];

  for (const a of anns) {
    const d = (a.description ?? "").trim().toLowerCase();
    if (!d) continue;
    if (d === target) {
      const c = centerOf(a.boundingPoly);
      return c.x > 0 ? c.x : null;
    }
  }

  return null;
}

function inferRiskWinSplitX(annotations: VisionAnn[]): number | null {
  if (!annotations || !annotations.length) return null;

  // Prefer the header words if present.
  const riskX = findWordCenterX(annotations, "Risk");
  // The column header is usually "To Win" (two tokens). Use Win if present; else To.
  const winX = findWordCenterX(annotations, "Win") ?? findWordCenterX(annotations, "To");

  if (riskX != null && winX != null && riskX > 0 && winX > 0) {
    // Put split in the middle of the two columns.
    return (riskX + winX) / 2;
  }

  return null;
}

function findTicketAnchorYFromVision(annotations: VisionAnn[], ticketNo: string): number | null {
  const anns = Array.isArray(annotations) ? annotations.slice(1) : [];

  const digitsOnly = (s: string) => (s ?? "").replace(/\D+/g, "");
  const tn = digitsOnly(ticketNo);
  if (!tn) return null;

  // BetMASS pending tickets are 9 digits in your screenshots; match by suffix to tolerate prefixes.
  const tnLast9 = tn.length >= 9 ? tn.slice(-9) : tn;

  // 1) exact token match
  const exact = anns.find((a) => {
    const d = digitsOnly(a.description ?? "");
    return d === tn || d === tnLast9;
  });
  if (exact) {
    const c = centerOf(exact.boundingPoly);
    return c.y > 0 ? c.y : null;
  }

  // 2) suffix match (handles tokens like "13" + ticket merged or other leading digits)
  const suffix = anns.find((a) => {
    const d = digitsOnly(a.description ?? "");
    return d.length >= tnLast9.length && d.endsWith(tnLast9);
  });
  if (suffix) {
    const c = centerOf(suffix.boundingPoly);
    return c.y > 0 ? c.y : null;
  }

  return null;
}

function nearestAmountByY(list: Array<{ value: number; x: number; y: number }>, y: number, maxDy = 40) {
  let best: { value: number; x: number; y: number } | null = null;
  let bestDy = Infinity;
  for (const a of list) {
    const dy = Math.abs(a.y - y);
    if (dy <= maxDy && dy < bestDy) {
      best = a;
      bestDy = dy;
    }
  }
  return best;
}
import type { ParsedSlip, MarketType, SideType } from "./types/parsedSlip";

export type ParseSlipOptions = {
  bookHint?: string | null;
  mode?: "auto" | "receipt" | "pending_list";
};

function toNumberMaybe(raw: string): number | null {
  const cleaned = raw.replace(/[,]/g, "").replace(/\$/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function inferAmericanOddsFromStakeToWin(stake: number | null, toWin: number | null): number | null {
  // Assumes `toWin` is PROFIT (not total return). Upstream normalizes "Return" -> profit when possible.
  if (stake == null || toWin == null) return null;
  if (!Number.isFinite(stake) || !Number.isFinite(toWin)) return null;
  if (stake <= 0 || toWin <= 0) return null;

  // If profit >= stake -> positive odds, else negative odds.
  if (toWin >= stake) {
    return Math.round((toWin / stake) * 100);
  }

  return -Math.round((stake / toWin) * 100);
}

function hasPlayerStatHint(text: string): boolean {
  const lower = (text ?? "").toLowerCase();
  const hints = [
    // basketball
    "points",
    "rebounds",
    "assists",
    "steals",
    "blocks",
    "three point",
    "three-point",
    "3 point",
    "3pt",
    "threes",
    "double double",
    "triple double",
    "field goals made",
    // football
    "yards",
    "receiving",
    "rushing",
    "passing",
    "receptions",
    "touchdowns",
    "td",
    "sacks",
    "interceptions",
    // baseball
    "strikeouts",
    "hits",
    "runs",
    "rbi",
    // hockey/soccer
    "goals",
    "shots",
  ];
  return hints.some((h) => lower.includes(h));
}

function extractPlayerNameFromLine(text: string): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // Require a stat hint so we don't misclassify random capitalized phrases.
  if (!hasPlayerStatHint(t)) return null;

  // Prefer "Proper Case" names first.
  let m = t.match(/\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)\s+([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)(?:\s+(Jr\.|Sr\.|II|III|IV))?\b/);

  // Fallback: OCR often returns ALL CAPS names.
  // Examples: "JAMES HARDEN", "KEL'EL WARE" (we'll allow apostrophes/hyphens)
  if (!m) {
    m = t.match(/\b([A-Z]{2,}(?:[-'][A-Z]{2,})?)\s+([A-Z]{2,}(?:[-'][A-Z]{2,})?)(?:\s+(JR\.|SR\.|II|III|IV))?\b/);
  }

  if (!m) return null;

  const first = m[1];
  const last = m[2];

  // Avoid obvious non-person matches.
  const badLast = new Set(["Teams", "Team", "Overtime", "Over", "Under", "Yes", "No", "Will"]);
  if (badLast.has(last) || badLast.has(last.toLowerCase() as any)) return null;

  // Normalize ALL CAPS -> Title Case for display
  const norm = (s: string) => {
    if (!s) return s;
    // Keep hyphen/apostrophe pieces readable
    return s
      .split(/([-'`])/)
      .map((part) => {
        if (part === "-" || part === "'" || part === "`") return part;
        if (part.toUpperCase() === part && /[A-Z]{2,}/.test(part)) {
          return part.charAt(0) + part.slice(1).toLowerCase();
        }
        return part;
      })
      .join("");
  };

  return `${norm(first)} ${norm(last)}`;
}

function isGamePropPhrase(line: string): boolean {
  const s = (line ?? "").toLowerCase();

  // Common game-prop phrases that should NOT be treated as player props.
  // (These often appear as "YES/NO" markets.)
  if (s.includes("overtime")) return true;

  // Draw / tie markets
  if (/(\bdraw\b|\btie\b|\btied\b|\bend\s+in\s+a\s+draw\b|\bdraw\s+no\s+bet\b)/i.test(line)) return true;

  // Both-teams style markets (e.g., "Both Teams To Score", "Both Teams To Score 110+", etc.)
  if (/\bboth\s+teams?\b/i.test(line)) return true;

  return false;
}

function detectMarketType(line: string): MarketType {
  // Strip inline odds like "@ -110" before classifying.
  const normalized = (line ?? "")
    .toLowerCase()
    .replace(/@\s*[+-]\d{2,5}\b/g, " ")
    .replace(/_\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "other";

  // Moneyline markers
  // Keep explicit "moneyline" as highest priority.
  if (normalized.includes("moneyline")) return "moneyline";

  // If it clearly looks like a player prop line, DO NOT allow a stray "ML" token to misclassify it.
  // OCR sometimes injects short tokens.
  if (hasPlayerStatHint(line)) return "player_prop";
  const inferredName = extractPlayerNameFromLine(line);
  if (inferredName) return "player_prop";

  if (/\bml\b/.test(normalized)) return "moneyline";

  // Totals (over/under)
  if (/\b(over|under)\b/.test(normalized) || normalized.includes(" total")) return "total";

  // Team total
  if (normalized.includes("team total") || /\btt\b/.test(normalized)) return "team_total";

  // TD markets
  if (normalized.includes("first td") || normalized.includes("first touchdown")) return "first_td";
  if (normalized.includes("anytime td") || normalized.includes("anytime touchdown")) return "anytime_td";

  // Alt markets
  if (normalized.includes("alt")) return "alt_line";

  // Futures
  if (normalized.includes("future")) return "future";

  // Game props (must run BEFORE player-prop detection to avoid misclassifying "Both Teams ..." as a player prop)
  if (normalized.includes("game prop") || isGamePropPhrase(line)) return "game_prop";

  // Player-prop markers (including your BetMASS phrasing)
  if (
    normalized.includes("to record") ||
    normalized.includes("double double") ||
    normalized.includes("triple double") ||
    normalized.includes("prop")
  ) {
    return "player_prop";
  }

  // Player-prop inference: if the raw line contains a player name AND a stat hint, classify as player_prop.
  // Example: "James Harden (LAC) 6+ Three Point Field Goals Made"
  // (Already handled above with inferredName.)

  // "To Score" / "To Hit" is ambiguous: it can be team/game props ("Both Teams To Score...") or player props.
  // If it's NOT a game-prop phrase, treat it as a player prop.
  if (normalized.includes("to score") || normalized.includes("to hit")) {
    return isGamePropPhrase(line) ? "game_prop" : "player_prop";
  }

  // Spread: look for a modest +/- line like -1.5 or +7 (avoid odds like -110)
  const spreadMatch = normalized.match(/\b([+-]\d+(?:\.\d+)?)\b/);
  if (spreadMatch) {
    const n = Number(spreadMatch[1]);
    if (Number.isFinite(n) && Math.abs(n) <= 30) return "spread";
  }

  return "other";
}

function parseEventFromText(text: string): string | null {
  // Matches things like "(DAL @ NOP)" or OCR variants like "(HOU [@ LAC)"
  const cleaned = (text ?? "")
    .replace(/\[@/g, "@")
    .replace(/\s+/g, " ")
    .trim();

  const m = cleaned.match(/\(([^)]+@[^)]+)\)/);
  return m ? m[1].replace(/[\[\]]/g, "").trim() : null;
}

function parsePlayerPropToRecord(text: string): { player: string | null; stat: string | null; event: string | null } {
  // Example: "To Record a Triple Double - Nikola Jokic (UTH @ DEN)"
  const cleaned = (text ?? "").replace(/_\s*/g, " ").replace(/\s+/g, " ").trim();
  const event = parseEventFromText(cleaned);

  // Stat detection
  let stat: string | null = null;
  if (/triple\s+double/i.test(cleaned)) stat = "triple double";
  else if (/double\s+double/i.test(cleaned)) stat = "double double";

  // Player extraction: take the part after the dash, before the parentheses
  let player: string | null = null;
  const dash = cleaned.split("-");
  if (dash.length >= 2) {
    const afterDash = dash.slice(1).join("-").trim();
    const beforeParen = afterDash.split("(")[0].trim();
    if (beforeParen) player = beforeParen;
  }

  return { player, stat, event };
}

function computeConfidenceAndIssues(args: {
  raw: string;
  market_type: MarketType;
  odds: number | null;
  event: string | null;
}): { confidence: number; issues: string[] } {
  let confidence = 0.35;
  const issues: string[] = [];

  if (args.odds != null) confidence += 0.2;
  else issues.push("missing_odds");

  if (args.event) confidence += 0.1;
  else issues.push("missing_event");

  if (args.market_type !== "other" && args.market_type !== "parlay") confidence += 0.2;
  else issues.push("unknown_market");

  // If we clearly detected a parlay leg style (has odds token)
  if (/@\s*[+-]\d{2,5}\b/.test(args.raw)) confidence += 0.1;

  // Clamp
  if (confidence > 0.95) confidence = 0.95;
  if (confidence < 0.05) confidence = 0.05;

  return { confidence, issues };
}

function detectSide(line: string): SideType {
  const s = line.toLowerCase();
  if (s.includes(" over ") || s.endsWith(" over") || /\bover\b/.test(s)) return "over";
  if (s.includes(" under ") || s.endsWith(" under") || /\bunder\b/.test(s)) return "under";
  if (s.includes(" yes") || /\byes\b/.test(s)) return "yes";
  if (s.includes(" no") || /\bno\b/.test(s)) return "no";
  return null;
}

function toParlayVariant(m: MarketType): MarketType {
  switch (m) {
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
    case "future":
      // Futures parlays are rare; keep generic
      return "parlay";
    case "other":
    default:
      return "parlay";
  }
}

function toMarketKey(betType: MarketType): string {
  // market_key is intended to be a stable, provider-friendly classifier for live tracking + analytics.
  // Keep it deterministic and prefer "Odds API-style" buckets where possible.
  if (!betType) return "other";

  // If this is a parlay variant, normalize to its base market for tracking.
  // Example: "spread_parlay" -> "spread"
  const base = (betType.endsWith("_parlay") ? (betType.replace(/_parlay$/, "") as MarketType) : betType);

  if (base === "moneyline") return "h2h";
  if (base === "spread" || base === "alt_line") return "spreads";
  if (base === "total") return "totals";
  if (base === "team_total") return "team_totals";

  if (base === "player_prop") return "player_props";
  if (base === "game_prop") return "game_props";

  if (base === "first_td") return "first_td";
  if (base === "anytime_td") return "anytime_td";
  if (base === "future") return "future";

  // A generic "parlay" row (not a leg) can't be live-tracked reliably by market.
  if (base === "parlay") return "parlay";

  return "other";
}

function inferPlayerPropMarketKey(text: string): string {
  const s = (text ?? "").toLowerCase();

  // Basketball
  if (s.includes("points") || /\bpts\b/.test(s)) return "player_points";
  if (s.includes("rebounds") || /\breb\b/.test(s)) return "player_rebounds";
  if (s.includes("assists") || /\bast\b/.test(s)) return "player_assists";
  if (s.includes("steals") || /\bstl\b/.test(s)) return "player_steals";
  if (s.includes("blocks") || /\bblk\b/.test(s)) return "player_blocks";

  // Common composite / specials
  if (s.includes("three point") || s.includes("three-point") || s.includes("3pt") || s.includes("3 pt") || s.includes("threes") || s.includes("three point field goals made")) {
    return "player_threes";
  }
  if (s.includes("double double") || s.includes("double-double")) return "player_double_double";
  if (s.includes("triple double") || s.includes("triple-double")) return "player_triple_double";

  // Football/baseball/hockey (generic buckets for now)
  if (s.includes("yards") || s.includes("receiving") || s.includes("rushing") || s.includes("passing") || s.includes("receptions")) return "player_yards_receptions";
  if (s.includes("touchdowns") || /\btd\b/.test(s)) return "player_tds";
  if (s.includes("strikeouts")) return "player_strikeouts";
  if (s.includes("goals") || s.includes("shots")) return "player_goals_shots";

  return "player_props";
}

function inferMarketKeyForLine(marketType: MarketType, selectionText: string): string {
  const base = (marketType && marketType.endsWith("_parlay"))
    ? (marketType.replace(/_parlay$/, "") as MarketType)
    : marketType;

  if (base === "player_prop") return inferPlayerPropMarketKey(selectionText);

  // Keep other keys as coarse buckets for now.
  return toMarketKey(marketType);
}

function isPendingListSlip(lines: string[]): boolean {
  const joined = lines.join(" ").toLowerCase();
  if (!joined.includes("pending")) return false;
  // BetMASS pending list usually shows column headers
  if (joined.includes("description") && joined.includes("risk") && joined.includes("to win")) return true;
  // Fallback: lots of repeated "basketball nba" style rows
  const nbaCount = lines.filter((l) => /\bbasketball\s+nba\b/i.test(l)).length;
  return nbaCount >= 2;
}

function extractMoneyAll(s: string): number[] {
  const out: number[] = [];
  const re = /\$\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function extractPendingListBets(lines: string[], visionAnnotations?: VisionAnn[]): Array<{
  ticketNo: string | null;
  sport: string | null;
  league: string | null;
  selection: string;
  event: string | null;
  risk: number | null;
  toWin: number | null;
}> {
  // Strategy: each bet starts with a header line like "374418765 | Basketball NBA".
  // Descriptions often wrap across OCR lines. Build a full segment (header + wrapped lines)
  // until the next header. Then extract the first two $ amounts from the entire segment
  // in reading order, which corresponds to Risk then To Win.

  const out: Array<{
    ticketNo: string | null;
    sport: string | null;
    league: string | null;
    selection: string;
    event: string | null;
    risk: number | null;
    toWin: number | null;
  }> = [];

  const headerRe = /(?:\b\d{1,2}\s+)?(\d{6,})\s*\|\s*([A-Za-z]+)\s+([A-Za-z0-9]+)/; // (optional idx) ticket | sport league

  // If we have Vision annotations, we can accurately read Risk vs To Win using column x positions.
  const amounts = visionAnnotations && visionAnnotations.length ? buildDollarAmountsFromVision(visionAnnotations) : [];

  // Prefer a dynamic split between the Risk and To Win columns using the header positions.
  // Fall back to fixed ranges if headers aren't found.
  const splitX = visionAnnotations && visionAnnotations.length ? inferRiskWinSplitX(visionAnnotations) : null;
  const riskHeaderX = visionAnnotations && visionAnnotations.length ? findWordCenterX(visionAnnotations, "Risk") : null;
  const winHeaderX = visionAnnotations && visionAnnotations.length ? (findWordCenterX(visionAnnotations, "Win") ?? findWordCenterX(visionAnnotations, "To")) : null;

  // Define a minimum X for “amount-like” columns so we don't accidentally use selection text numbers.
  const minAmountX = riskHeaderX != null && riskHeaderX > 0 ? Math.max(0, riskHeaderX - 120) : 720;

  const riskAmounts = splitX != null
    ? amounts.filter((a) => a.x >= minAmountX && a.x < splitX)
    : amounts.filter((a) => a.x >= 760 && a.x <= 950);

  const winAmounts = splitX != null
    ? amounts.filter((a) => a.x >= splitX)
    : amounts.filter((a) => a.x >= 980 && a.x <= 1250);

  // If headers are present, also tighten to the vicinity of the header columns (helps on wide screenshots)
  const riskTight = (riskHeaderX != null && riskHeaderX > 0)
    ? riskAmounts.filter((a) => Math.abs(a.x - riskHeaderX) < 220)
    : riskAmounts;

  const winTight = (winHeaderX != null && winHeaderX > 0)
    ? winAmounts.filter((a) => Math.abs(a.x - winHeaderX) < 260)
    : winAmounts;

  const riskAmountsFinal = riskTight.length ? riskTight : riskAmounts;
  const winAmountsFinal = winTight.length ? winTight : winAmounts;

  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    const m = headerLine.match(headerRe);
    if (!m) {
      i++;
      continue;
    }

    const rawTicket = m[1] ?? null;
    const ticketNo = rawTicket ? rawTicket.replace(/\D+/g, "").slice(-9) : null;
    const sport = m[2] ?? null;
    const league = m[3] ?? null;

    // Collect following lines until next header; build a full segment so wrapped descriptions
    // don't cause risk/toWin to be pulled from adjacent rows.
    const chunk: string[] = [];

    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (headerRe.test(next)) break;

      // Skip global headers/sections
      const low = next.toLowerCase();
      if (low.includes("description") && low.includes("risk")) {
        j++;
        continue;
      }
      if (low === "pending" || low === "transactions" || low === "figures") {
        j++;
        continue;
      }

      if (next.trim()) chunk.push(next.trim());

      // Heuristic: cap segment length to avoid runaway, but DO NOT stop early based on money count.
      if (chunk.length >= 10) {
        j++;
        break;
      }

      j++;
    }

    const segmentRaw = [headerLine, ...chunk].join("\n");

    const combined = chunk
      .join(" ")
      .replace(/_\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const event = parseEventFromText(combined);

    // Remove parenthetical event and any $ amounts from selection to reduce noise
    const selection = combined
      .replace(/\([^)]*@[^)]*\)/g, "")
      .replace(/\$\s*[0-9]+(?:\.[0-9]{1,2})?/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Prefer Vision geometry-based extraction (works even when Risk is red / not present in plain text).
    // Fall back to regex scanning of the segment if Vision isn't provided.
    let risk: number | null = null;
    let toWin: number | null = null;

    if (ticketNo && visionAnnotations && visionAnnotations.length) {
      const anchorY = findTicketAnchorYFromVision(visionAnnotations, ticketNo);
      if (anchorY != null) {
        const r = nearestAmountByY(riskAmountsFinal, anchorY, 65);
        const w = nearestAmountByY(winAmountsFinal, anchorY, 65);
        risk = r ? r.value : null;
        toWin = w ? w.value : null;
      }
    }

    if (risk == null || toWin == null) {
      const monies = extractMoneyAll(segmentRaw);

      // In the pending list rows, the (risk, toWin) pair usually appears together.
      // Prefer the first adjacent pair we see; if many are present, keep the first pair.
      if (monies.length >= 2) {
        if (risk == null) risk = monies[0];
        if (toWin == null) toWin = monies[1];
      } else {
        // If we only found one $ amount in text, don't guess which column it belongs to.
        // Leave the missing one null so the review UI can prompt.
        if (risk == null) risk = null;
        if (toWin == null) toWin = null;
      }
    }

    // Only add if we have a non-empty selection
    if (selection) {
      out.push({ ticketNo, sport, league, selection, event, risk, toWin });
    }

    i = j;
  }

  return out;
}

function extractParlayLegs(lines: string[]): Array<{ text: string; odds: number | null }> {
  // Strategy: accumulate wrapped lines until we hit a trailing odds token like "@-193".
  const legs: Array<{ text: string; odds: number | null }> = [];
  const ignore = (l: string) => {
    const s = l.toLowerCase();
    return (
      s.includes("view legs") ||
      s.includes("home") && s.includes("scores") ||
      s.includes("balance") ||
      s.startsWith("odds") ||
      s.startsWith("wager") ||
      s.startsWith("return") ||
      s.startsWith("close") ||
      s === "ml" ||
      s === "m l"
    );
  };

  const oddsToken = /@\s*([+-]\d{2,5})\b/;
  let buf: string[] = [];

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (ignore(l)) continue;

    // Skip the header line like "3 LEG PARLAY"
    if (/\bleg\s+parlay\b/i.test(l) || /\bparlay\b/i.test(l)) {
      // don't reset buffer; just skip header
      continue;
    }

    buf.push(l);

    const joined = buf.join(" ").replace(/_\s*/g, " ").replace(/\s+/g, " ").trim();
    const m = joined.match(oddsToken);
    if (m) {
      const odds = Number(m[1]);
      // Remove the odds token from the selection text
      const text = joined.replace(oddsToken, "").replace(/\s+/g, " ").trim();
      legs.push({ text, odds: Number.isFinite(odds) ? odds : null });
      buf = [];
    }
  }

  return legs;
}

/**
 * Best-effort OCR parser.
 * Phase 1 goal: return a stable ParsedSlip shape (even if most fields are null)
 * so the Review UI can render editable rows.
 */
export function parseSlipFromOcr(ocrInput: OcrInput, opts: ParseSlipOptions = {}): ParsedSlip {
  const { text: rawText, annotations } = getTextAndAnnotations(ocrInput);
  const text = stripDebugLines((rawText ?? "").replace(/\r/g, ""));
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const pendingListHint = opts.mode === "pending_list" || (opts.mode !== "receipt" && isPendingListSlip(lines));

  const parlayHint = lines.some(
    (l) => /\bparlay\b/i.test(l) || /\bleg\s+parlay\b/i.test(l) || /view\s+legs/i.test(l)
  );

  // Try to extract legs count if present (e.g., "3 LEG PARLAY")
  const legsCountFromText = (() => {
    const m = lines.join(" ").match(/(\d+)\s*leg\s*parlay/i);
    return m ? Number(m[1]) : null;
  })();

  // Slip-level amounts
  let wager: number | null = null;
  let to_win: number | null = null;
  let odds_american: number | null = null;

  if (!pendingListHint) {
    const wagerLine = lines.find((l) => /\bwager\b/i.test(l));
    const returnLine = lines.find((l) => /\breturn\b/i.test(l) || /\bto win\b/i.test(l));
    const oddsLine = lines.find((l) => /\bodds\b/i.test(l));

    wager = wagerLine ? toNumberMaybe(wagerLine.split(/wager\s*:?/i).pop() ?? "") : null;

    // Some slips use:
    // - "To Win" = profit
    // - "Return" = total return (stake + profit)
    // OCR can also mix these labels. We'll parse both and normalize to `to_win` (profit).
    const toWinRaw = returnLine?.match(/to\s*win\s*:?\s*(\$?\s*[0-9,.]+(?:\.[0-9]{1,2})?)/i);
    const returnRaw = returnLine?.match(/return\s*:?\s*(\$?\s*[0-9,.]+(?:\.[0-9]{1,2})?)/i);

    const parsedToWin = toWinRaw ? toNumberMaybe(toWinRaw[1]) : null;
    const parsedReturn = returnRaw ? toNumberMaybe(returnRaw[1]) : null;

    if (parsedToWin != null) {
      to_win = parsedToWin;
    } else if (parsedReturn != null) {
      // Convert total return -> profit when we have stake
      if (wager != null && Number.isFinite(wager) && parsedReturn > wager) {
        to_win = Math.round((parsedReturn - wager) * 100) / 100;
      } else {
        // If we can't safely convert, store the parsed value as-is.
        to_win = parsedReturn;
      }
    } else {
      // Fallback to previous behavior (last token after label)
      to_win = returnLine
        ? toNumberMaybe(
            (
              returnLine.split(/return\s*:?/i).pop() ??
              returnLine.split(/to win\s*:?/i).pop() ??
              ""
            ).trim()
          )
        : null;
    }

    // Odds might look like "+237" / "-110" on the slip
    const oddsMatch = oddsLine?.match(/([+-]\d{2,5})/);
    odds_american = oddsMatch ? Number(oddsMatch[1]) : null;
    // If the slip doesn't state odds (or OCR missed it), infer from Wager and To Win/Return.
    // Example: $6 to win $219 -> +3650.
    if (odds_american == null) {
      const inferred = inferAmericanOddsFromStakeToWin(wager, to_win);
      if (inferred != null) odds_american = inferred;
    }
  } else {
    wager = null;
    to_win = null;
    odds_american = null;
  }

  const betLines = pendingListHint
    ? []
    : lines.filter((l) => {
        const s = l.toLowerCase();
        if (s.startsWith("odds")) return false;
        if (s.startsWith("wager")) return false;
        if (s.startsWith("return") || s.startsWith("to win")) return false;
        if (s.startsWith("close")) return false;
        if (s.includes("successfully submitted")) return false;
        if (s.includes("view legs")) return false;
        if (s.includes("leg parlay")) return false;
        if (s.includes("parlay")) return false;

        return (
          /\b(over|under)\b/i.test(l) ||
          /\bto record\b/i.test(l) ||
          /@\s*[+-]\d{2,5}\b/.test(l) ||
          /[+-]\d{2,5}/.test(l)
        );
      });

  // If this is a parlay slip, extract legs as individual parlay_leg bets if possible.
  const bets: ParsedSlip["bets"] = (() => {
    if (pendingListHint) {
      const rows = extractPendingListBets(lines, annotations);
      const built = rows.map((r) => {
        const market_type = detectMarketType(r.selection);
        const side = detectSide(r.selection);
        const { confidence, issues } = computeConfidenceAndIssues({
          raw: r.selection,
          market_type,
          odds: null,
          event: r.event,
        });

        return {
          kind: "single" as const,
          sport: r.sport,
          league: r.league,
          event: r.event,
          event_date: null,
          home_team: null,
          away_team: null,
          market_type,
          market_key: inferMarketKeyForLine(market_type, r.selection),
          market_text: null,
          selection_text: r.selection,
          player: market_type === "player_prop" ? extractPlayerNameFromLine(r.selection) : null,
          stat: null,
          period: null,
          line: null,
          side,
          team: null,
          // Insert per-bet amounts and ticket number near odds_american
          odds_american: null,
          stake: r.risk ?? null,
          to_win: r.toWin ?? null,
          ticket_no: r.ticketNo ?? null,
          is_alt: market_type === "alt_line" ? true : null,
          is_live: null,
          confidence: Math.min(0.8, confidence + 0.2),
          issues: ["pending_list", ...(r.risk == null ? ["missing_risk"] : []), ...issues],
        };
      });

      return built.length ? built : [{
        kind: "single",
        sport: null,
        league: null,
        event: null,
        event_date: null,
        home_team: null,
        away_team: null,
        market_type: "other",
        market_key: inferMarketKeyForLine("other", lines.join(" | ")),
        market_text: "pending_list",
        selection_text: lines.join(" | "),
        player: null,
        stat: null,
        period: null,
        line: null,
        side: null,
        team: null,
        odds_american: null,
        stake: null,
        to_win: null,
        ticket_no: null,
        is_alt: null,
        is_live: null,
        confidence: 0.3,
        issues: ["pending_list_unparsed", "needs_review"],
      }];
    }

    if (parlayHint) {
      const legs = extractParlayLegs(lines);

      // If we successfully extracted 2+ legs, return them as parlay_leg rows.
      if (legs.length >= 2) {
        return legs.map((leg) => {
          const baseMarket = detectMarketType(leg.text);
          // Extra guard: if a leg has player-prop hints, force it to player_prop.
          const guardedBaseMarket: MarketType = hasPlayerStatHint(leg.text) || extractPlayerNameFromLine(leg.text)
            ? "player_prop"
            : baseMarket;
          const market_type = toParlayVariant(guardedBaseMarket);
          const side = detectSide(leg.text);

          // Try to pull richer structure for common player-prop phrasing
          const evt = parseEventFromText(leg.text);
          const toRecord = /\bto\s+record\b/i.test(leg.text) ? parsePlayerPropToRecord(leg.text) : null;

          const event = toRecord?.event ?? evt;
          const player = toRecord?.player ?? (market_type === "player_prop_parlay" ? extractPlayerNameFromLine(leg.text) : null);
          const stat = toRecord?.stat ?? null;

          const { confidence, issues } = computeConfidenceAndIssues({
            raw: leg.text,
            market_type,
            odds: leg.odds,
            event,
          });

          return {
            kind: "parlay_leg",
            sport: null,
            league: null,
            event: event ?? null,
            event_date: null,
            home_team: null,
            away_team: null,
            market_type,
            market_key: inferMarketKeyForLine(market_type, leg.text),
            market_text: null,
            selection_text: leg.text,
            player,
            stat,
            period: null,
            line: null,
            side,
            team: null,
            odds_american: leg.odds,
            is_alt: market_type === "alt_line_parlay" ? true : null,
            is_live: null,
            confidence,
            issues: ["parlay_leg", ...issues],
          };
        });
      }

      // Fallback: if we couldn't split legs reliably, keep previous combined behavior.
      if (betLines.length > 1) {
        const combined = betLines.join(" | ");

        const legTypes = betLines.map((l) => detectMarketType(l));
        const unique = Array.from(new Set(legTypes));

        const parlayMarket: MarketType = (() => {
          // If the combined text clearly looks like player props, do NOT allow an "ML" token to override it.
          if (hasPlayerStatHint(combined) || extractPlayerNameFromLine(combined)) return "player_prop_parlay";
          if (isGamePropPhrase(combined)) return "game_prop_parlay";

          if (unique.length === 1) {
            return toParlayVariant(unique[0]);
          }

          if (unique.includes("player_prop")) return "player_prop_parlay";
          if (unique.includes("game_prop")) return "game_prop_parlay";
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
            market_key: inferMarketKeyForLine(parlayMarket, combined),
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
    }

    return betLines.map((line) => {
      const baseMarket = detectMarketType(line);
      const guardedBaseMarket: MarketType = hasPlayerStatHint(line) || extractPlayerNameFromLine(line)
        ? "player_prop"
        : baseMarket;
      const kind = betLines.length > 1 ? ("parlay_leg" as const) : ("single" as const);

      // If we have multiple bet lines but couldn't reliably split legs via the parlay extractor,
      // treat each line as a parlay leg and normalize market_type to its *_parlay variant.
      const market_type: MarketType = kind === "parlay_leg" ? toParlayVariant(guardedBaseMarket) : guardedBaseMarket;

      const side = detectSide(line);

      const om = line.match(/(?:@\s*)?([+-]\d{2,5})\b/);
      const lineOdds = om ? Number(om[1]) : null;

      const event = parseEventFromText(line);
      const { confidence, issues } = computeConfidenceAndIssues({
        raw: line,
        market_type,
        odds: lineOdds,
        event,
      });

      return {
        kind,
        sport: null,
        league: null,
        event: event ?? null,
        event_date: null,
        home_team: null,
        away_team: null,
        market_type,
        market_key: inferMarketKeyForLine(market_type, line),
        market_text: null,
        selection_text: line,
        player: (market_type === "player_prop" || market_type === "player_prop_parlay")
          ? extractPlayerNameFromLine(line)
          : null,
        stat: null,
        period: null,
        line: null,
        side,
        team: null,
        odds_american: lineOdds,
        is_alt: (market_type === "alt_line" || market_type === "alt_line_parlay") ? true : null,
        is_live: null,
        confidence,
        issues: issues.length ? issues : ["needs_review"],
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
    bet_style: pendingListHint ? "unknown" : parlayHint ? "parlay" : bets.length === 1 ? "single" : "unknown",
    legs_count: pendingListHint ? (bets.length || null) : parlayHint ? (legsCountFromText ?? (bets.length || null)) : (bets.length || null),
    bets,
    meta: {
      parser_version: "dev",
      source: "ocr",
    },
  };

  return parsed;
}

export default parseSlipFromOcr;
