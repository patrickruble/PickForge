// backend/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

import { JWT } from "google-auth-library";
import {
  fetchOddsEventMarkets,
  fetchOddsEventPlayerProps,
} from "./src/providers/oddsApi.ts";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const ODDS_KEY = process.env.ODDS_API_KEY;
const PORT = process.env.PORT || 8787;

if (!ODDS_KEY) {
  console.error(" Missing ODDS_API_KEY in backend/.env");
  process.exit(1);
}

// ---- Supabase (for syncing scores into `games`) ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

if (!supabase) {
  console.warn(
    "⚠️ Supabase client not initialized – set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable games sync."
  );
}

// ------- helpers -------
const LEAGUE_MAP = {
  nfl: "americanfootball_nfl",
  ncaaf: "americanfootball_ncaaf",
  nba: "basketball_nba",
};

function mapLeague(q) {
  const k = String(q || "nfl").toLowerCase();
  return LEAGUE_MAP[k] ?? LEAGUE_MAP.nfl;
}

function mapMarkets(q) {
  // Accept aliases; Odds API expects 'h2h' for moneyline
  const parts = String(q || "spreads,moneyline")
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const mapped = parts.map((m) =>
    m === "moneyline" || m === "ml" ? "h2h" : m
  );
  const allow = new Set(["spreads", "h2h", "totals"]);
  return (
    [...new Set(mapped.filter((m) => allow.has(m)))].join(",") || "spreads,h2h"
  );
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error("Request timed out")), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

// tiny cache to avoid hammering free tier
const cache = new Map(); // key -> { data, exp }
function getCache(key) {
  const v = cache.get(key);
  if (v && v.exp > Date.now()) return v.data;
  cache.delete(key);
  return null;
}
function setCache(key, data, ttlMs = 30_000) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

// ---- ESPN scoreboard helpers (historical-safe) ----
function mapDbLeagueFromKey(leagueKey) {
  const k = String(leagueKey || "");
  if (k.includes("basketball_nba")) return "nba";
  if (k.includes("nfl")) return "nfl";
  if (k.includes("ncaaf")) return "ncaaf";
  return "nfl";
}

function espnSportPath(dbLeague) {
  // ESPN uses different paths for NFL vs college football
  return dbLeague === "ncaaf" ? "football/college-football" : "football/nfl";
}

async function fetchEspnScoreboard({ dbLeague = "nfl", year, week, seasontype = 2 }) {
  // seasontype: 1=preseason, 2=regular, 3=postseason
  const path = espnSportPath(dbLeague);
  const url = new URL(
    `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`
  );
  if (year != null) url.searchParams.set("year", String(year));
  if (week != null) url.searchParams.set("week", String(week));
  if (seasontype != null) url.searchParams.set("seasontype", String(seasontype));

  const t = withTimeout(12_000);
  const resp = await fetch(url.toString(), { signal: t.signal }).finally(t.cancel);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`ESPN scoreboard HTTP ${resp.status}: ${txt}`);
  }
  return (await resp.json()) ?? {};
}

function parseEspnStatus(evt) {
  // Prefer completed/final semantics; ESPN provides status.type
  const st = evt?.status?.type;
  if (!st) return { status: "scheduled", completed: false };
  if (st.completed) return { status: "final", completed: true };
  if (st.state === "in") return { status: "live", completed: false };
  return { status: "scheduled", completed: false };
}

function parseEspnCompetitionToGameRow({ evt, dbLeague, weekOverride }) {
  const comp = (evt?.competitions && evt.competitions[0]) || null;
  const competitors = comp?.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");

  const homeName = home?.team?.displayName || home?.team?.name || null;
  const awayName = away?.team?.displayName || away?.team?.name || null;

  const homeScore = home?.score != null ? parseInt(home.score, 10) : null;
  const awayScore = away?.score != null ? parseInt(away.score, 10) : null;

  const { status } = parseEspnStatus(evt);

  // Use ESPN event id as our game id; picks must align to this for full historical grading
  const id = String(evt?.id || "");

  const kickoff_time = evt?.date || comp?.date || null;

  // Week: prefer explicit override (from request) else attempt to read from event.week
  const weekFromEvent = evt?.week?.number ?? null;
  const week = weekOverride ?? weekFromEvent;

  return {
    id,
    league: dbLeague,
    week,
    home_team: homeName,
    away_team: awayName,
    kickoff_time,
    status,
    home_score: Number.isFinite(homeScore) ? homeScore : null,
    away_score: Number.isFinite(awayScore) ? awayScore : null,
  };
}

function normalizeTeamName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Bet settlement helpers (Odds API scores) ----
const NBA_ABBR = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  BRK: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  GS: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NO: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};

const NFL_ABBR = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  GNB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  JAC: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  KCC: "Kansas City Chiefs",
  LAC: "Los Angeles Chargers",
  LACH: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  LARM: "Los Angeles Rams",
  LV: "Las Vegas Raiders",
  LVR: "Las Vegas Raiders",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NWE: "New England Patriots",
  NO: "New Orleans Saints",
  NOS: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SEA: "Seattle Seahawks",
  SF: "San Francisco 49ers",
  SFO: "San Francisco 49ers",
  TB: "Tampa Bay Buccaneers",
  TBB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WAS: "Washington Commanders",
  WSH: "Washington Commanders",
  WFT: "Washington Commanders",
};

function teamTokenToName(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const upper = t.toUpperCase();

  // Prefer exact abbreviation maps for known leagues
  if (NBA_ABBR[upper]) return NBA_ABBR[upper];
  if (NFL_ABBR[upper]) return NFL_ABBR[upper];

  return t;
}

function parseEventTeams(eventName) {
  const raw = String(eventName || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  // Common formats from OCR:
  // "HOU @ LAC" -> away=HOU home=LAC
  // "HOU vs LAC" -> home/away unknown (treat as home=left, away=right)
  let m = raw.match(/\b([^@]+?)\s*@\s*([^@]+)\b/i);
  if (m) {
    const awayTok = m[1].trim();
    const homeTok = m[2].trim();
    return {
      away: teamTokenToName(awayTok),
      home: teamTokenToName(homeTok),
      awayTok,
      homeTok,
    };
  }

  m = raw.match(/\b(.+?)\s+vs\.?\s+(.+?)\b/i);
  if (m) {
    const left = m[1].trim();
    const right = m[2].trim();
    return {
      home: teamTokenToName(left),
      away: teamTokenToName(right),
      homeTok: left,
      awayTok: right,
    };
  }

  return null;
}

function tryParseOddsAmerican(selectionText) {
  const t = String(selectionText || "");
  const m = t.match(/(?:@\s*)?([+-]\d{2,5})\b/);
  return m ? Number(m[1]) : null;
}

function tryParseSpread(selectionText) {
  // Returns { teamTok, line } where line is numeric (e.g. -2.5)
  const t = String(selectionText || "");
  const m = t.match(/\b([A-Za-z]{2,4})\b[^\d+-]*([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const teamTok = m[1];
  const line = Number(m[2]);
  if (!Number.isFinite(line)) return null;
  return { teamTok, line };
}

function tryParseTotal(selectionText) {
  // Returns { side: 'over'|'under', line }
  const t = String(selectionText || "").toLowerCase();
  const side = t.includes("under") ? "under" : t.includes("over") ? "over" : null;
  const m = t.match(/\b(\d{2,3}(?:\.\d+)?)\b/);
  const line = m ? Number(m[1]) : null;
  if (!side || !Number.isFinite(line)) return null;
  return { side, line };
}

function inferSportKeyFromBetSport(sport) {
  const s = String(sport || "").toLowerCase();
  if (s.includes("nba") || s.includes("basketball")) return "basketball_nba";
  if (s.includes("nfl") || s.includes("football")) return "americanfootball_nfl";
  // add more as you expand
  return null;
}

function parseNotesJson(notes) {
  if (!notes) return null;
  if (typeof notes === "object") return notes;
  try {
    return JSON.parse(String(notes));
  } catch {
    return null;
  }
}

function isCloseTime(aIso, bIso, hours = 12) {
  const a = aIso ? new Date(aIso).getTime() : NaN;
  const b = bIso ? new Date(bIso).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= hours * 60 * 60 * 1000;
}

async function backfillGamesFromEspn({ leagueKey, year, week, seasontype = 2 }) {
  if (!supabase) {
    console.warn("[espn-backfill] Supabase not configured, skipping.");
    return { upserted: 0 };
  }

  const dbLeague = mapDbLeagueFromKey(leagueKey);
  console.log("[espn-backfill] start", { dbLeague, year, week, seasontype });

  // Load picks for this league/week so we can map ESPN events -> existing Odds game IDs
  // We try to get team/time from picks; if schema doesn't include it, we fallback to the games table.
  let picks = [];
  try {
    // Always get at least game_id
    const base = await supabase
      .from("picks")
      .select("game_id, week")
      .eq("league", dbLeague)
      .eq("week", week);

    if (base.error) throw base.error;
    picks = base.data || [];

    // Try to also fetch team/time from picks (may fail if columns don't exist)
    const rich = await supabase
      .from("picks")
      .select("game_id, home_team, away_team, kickoff_time")
      .eq("league", dbLeague)
      .eq("week", week);

    if (!rich.error && Array.isArray(rich.data) && rich.data.length) {
      // Merge rich fields into picks by game_id
      const byId = new Map(rich.data.map((r) => [r.game_id, r]));
      picks = picks.map((p) => ({ ...p, ...(byId.get(p.game_id) || {}) }));
    }
  } catch (e) {
    console.warn("[espn-backfill] could not load picks for mapping:", e?.message || e);
    picks = [];
  }

  // If picks lack team/time, try to enrich from existing games rows
  let enrichedFromGames = 0;
  try {
    const ids = [...new Set(picks.map((p) => p.game_id).filter(Boolean))];
    const needsEnrich = picks.some(
      (p) => !p.home_team || !p.away_team || !p.kickoff_time
    );

    if (ids.length && needsEnrich) {
      const { data: gRows, error: gErr } = await supabase
        .from("games")
        .select("id, home_team, away_team, kickoff_time")
        .in("id", ids);

      if (!gErr && Array.isArray(gRows) && gRows.length) {
        const byId = new Map(gRows.map((g) => [g.id, g]));
        picks = picks.map((p) => {
          const g = byId.get(p.game_id);
          if (!g) return p;
          const before = (!!p.home_team && !!p.away_team && !!p.kickoff_time);
          const out = {
            ...p,
            home_team: p.home_team || g.home_team,
            away_team: p.away_team || g.away_team,
            kickoff_time: p.kickoff_time || g.kickoff_time,
          };
          const after = (!!out.home_team && !!out.away_team && !!out.kickoff_time);
          if (!before && after) enrichedFromGames += 1;
          return out;
        });
      }
    }
  } catch (e) {
    console.warn("[espn-backfill] games enrichment skipped:", e?.message || e);
  }

  // Build match index: home|away -> [{ game_id, kickoff_time }]
  const matchIndex = new Map();
  for (const p of picks) {
    if (!p?.game_id) continue;
    const h = normalizeTeamName(p.home_team);
    const a = normalizeTeamName(p.away_team);
    if (!h || !a) continue;
    const key = `${h}|${a}`;
    const arr = matchIndex.get(key) || [];
    arr.push({ game_id: p.game_id, kickoff_time: p.kickoff_time || null });
    matchIndex.set(key, arr);
  }

  const json = await fetchEspnScoreboard({ dbLeague, year, week, seasontype });
  const events = Array.isArray(json?.events) ? json.events : [];

  const rows = [];
  let matched = 0;

  for (const evt of events) {
    const parsed = parseEspnCompetitionToGameRow({
      evt,
      dbLeague,
      weekOverride: week != null ? Number(week) : null,
    });

    // Require minimum data
    if (!parsed.home_team || !parsed.away_team || parsed.week == null) continue;

    // Default id = ESPN event id
    let id = parsed.id;

    // If we have mapping info, try to swap id to the existing Odds game_id so grading works.
    const key = `${normalizeTeamName(parsed.home_team)}|${normalizeTeamName(parsed.away_team)}`;
    const candidates = matchIndex.get(key);

    if (candidates && candidates.length) {
      // Prefer a candidate with a close kickoff_time match; else take first.
      const exact = candidates.find((c) => isCloseTime(c.kickoff_time, parsed.kickoff_time, 18));
      id = (exact?.game_id || candidates[0]?.game_id || id);
      matched += 1;
    }

    rows.push({
      ...parsed,
      id,
    });
  }

  if (!rows.length) {
    console.log("[espn-backfill] no rows parsed");
    return { upserted: 0 };
  }

  const { error } = await supabase.from("games").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("[espn-backfill] upsert error:", error);
    return { upserted: 0, error };
  }

  console.log(
    `[espn-backfill] Upserted ${rows.length} games for ${dbLeague} week=${week} (matched to picks: ${matched}, enrichedFromGames: ${enrichedFromGames})`
  );
  return { upserted: rows.length, matched, enrichedFromGames };
}

// Build a quick index of games for server-side lock validation
async function fetchGamesIndex(leagueKey) {
  const url = new URL(
    `https://api.the-odds-api.com/v4/sports/${leagueKey}/odds`
  );
  url.searchParams.set("apiKey", ODDS_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "american");

  const t = withTimeout(12_000);
  const resp = await fetch(url, { signal: t.signal }).finally(t.cancel);
  if (!resp.ok) throw new Error(`odds upstream failed: ${resp.status}`);
  const raw = await resp.json();

  const idx = new Map();
  for (const g of raw || []) {
    idx.set(g.id, {
      commenceTime: g.commence_time,
      home: g.home_team,
      away: g.away_team,
    });
  }
  return idx;
}

// ---- sync scores into Supabase `games` table ----
async function syncGamesFromPicks(leagueKey) {
  if (!supabase) {
    console.warn("[games-sync] Supabase not configured, skipping.");
    return;
  }

  // Odds API key like "americanfootball_nfl" → DB stores 'nfl' / 'ncaaf'
  const dbLeague = mapDbLeagueFromKey(leagueKey);

  try {
    console.log("[games-sync] start", { leagueKey, dbLeague });

    // 1) Look at picks so we know which game_ids + weeks we care about
    const { data: picks, error: picksError } = await supabase
      .from("picks")
      .select("game_id, week")
      .eq("league", dbLeague);

    if (picksError) {
      console.error("[games-sync] picks error:", picksError);
      return;
    }

    const weekByGame = new Map();
    if (picks && picks.length) {
      for (const p of picks) {
        if (!p.game_id) continue;
        // first week wins; all picks for same game_id are same week anyway
        if (!weekByGame.has(p.game_id)) {
          weekByGame.set(p.game_id, p.week);
        }
      }
    }

    console.log(
      "[games-sync] picks loaded",
      picks ? picks.length : 0,
      "unique games:",
      weekByGame.size
    );

    if (weekByGame.size === 0) {
      console.log("[games-sync] no games with picks yet, skipping.");
      return;
    }

    // 2) Fetch scores from The Odds API (recent games)
    const scoresUrl = new URL(
      `https://api.the-odds-api.com/v4/sports/${leagueKey}/scores`
    );
    scoresUrl.searchParams.set("apiKey", ODDS_KEY);
    scoresUrl.searchParams.set("daysFrom", "3"); // look a few days around today
    scoresUrl.searchParams.set("dateFormat", "iso");

    const resp = await fetch(scoresUrl.toString());
    if (!resp.ok) {
      const txt = await resp.text();
      console.error(
        "[games-sync] scores HTTP error:",
        resp.status,
        resp.statusText,
        txt
      );
      return;
    }

    const apiGames = (await resp.json()) ?? [];
    console.log("[games-sync] scores from API:", apiGames.length);

    if (!apiGames.length) {
      console.log("[games-sync] no games from scores endpoint");
      return;
    }

    // 3) Build rows to upsert into `games`
    const rows = [];
    const weeksCoveredByScores = new Set();

    for (const g of apiGames) {
      const week = weekByGame.get(g.id);
      // Only sync games we actually have picks for
      if (week == null) continue;
      weeksCoveredByScores.add(week);

      let homeScore = null;
      let awayScore = null;
      let hasScores = false;

      if (Array.isArray(g.scores)) {
        const homeRow = g.scores.find((s) => s.name === g.home_team);
        const awayRow = g.scores.find((s) => s.name === g.away_team);

        if (homeRow?.score != null) {
          const parsed = parseInt(homeRow.score, 10);
          if (!Number.isNaN(parsed)) {
            homeScore = parsed;
            hasScores = true;
          }
        }
        if (awayRow?.score != null) {
          const parsed = parseInt(awayRow.score, 10);
          if (!Number.isNaN(parsed)) {
            awayScore = parsed;
            hasScores = true;
          }
        }
      }

      // Decide game status:
      // - completed -> "final"
      // - has scores but not completed -> "live"
      // - no scores yet -> "scheduled"
      let status = "scheduled";

      if (g.completed) {
        status = "final";
      } else if (hasScores) {
        status = "live";
      }

      rows.push({
        id: g.id,
        league: dbLeague, // 'nfl' | 'ncaaf'
        week, // guaranteed non-null
        home_team: g.home_team,
        away_team: g.away_team,
        kickoff_time: g.commence_time,
        status,
        home_score: homeScore,
        away_score: awayScore,
      });
    }

    // Determine which picked weeks were NOT covered by the Odds API scores window
    const pickedWeeks = [...new Set([...weekByGame.values()].filter((w) => w != null))];
    const missingWeeks = pickedWeeks.filter((w) => !weeksCoveredByScores.has(w));

    // Try current year first; allow override via env if needed
    const year = process.env.SEASON_YEAR ? Number(process.env.SEASON_YEAR) : new Date().getFullYear();

    if (!rows.length) {
      console.log(
        "[games-sync] no matching games with scores to upsert. Attempting ESPN backfill for picked weeks..."
      );

      let total = 0;
      for (const wk of pickedWeeks) {
        try {
          const r = await backfillGamesFromEspn({ leagueKey, year, week: wk, seasontype: 2 });
          total += r?.upserted || 0;
        } catch (e) {
          console.error("[games-sync] ESPN backfill error:", e?.message || e);
        }
      }

      console.log("[games-sync] ESPN backfill finished", { total });
      return;
    }

    // If we did upsert some rows, still backfill older picked weeks that weren't covered by /scores
    if (missingWeeks.length) {
      console.log(
        "[games-sync] scores window missed some picked weeks; attempting ESPN backfill",
        { missingWeeks }
      );

      let total = 0;
      for (const wk of missingWeeks) {
        try {
          const r = await backfillGamesFromEspn({ leagueKey, year, week: wk, seasontype: 2 });
          total += r?.upserted || 0;
        } catch (e) {
          console.error("[games-sync] ESPN backfill error:", e?.message || e);
        }
      }

      console.log("[games-sync] ESPN backfill finished (missingWeeks)", { total });
    }

    console.log("[games-sync] upserting rows:", rows.length);

    const { error: upsertError } = await supabase
      .from("games")
      .upsert(rows, { onConflict: "id" });

    if (upsertError) {
      console.error("[games-sync] upsert error:", upsertError);
    } else {
      console.log(
        `[games-sync] Upserted ${rows.length} games for league=${dbLeague}`
      );
    }
  } catch (err) {
    console.error("[games-sync] unexpected error:", err);
  }
}

// ------- routes -------




app.get("/health", (_req, res) => res.json({ ok: true }));

// --------------------------------------------------
// Odds API — Debug: raw markets for an event
// --------------------------------------------------
app.get("/api/odds/event-markets", async (req, res) => {
  try {
    const sportKey = String(req.query.sportKey || "").trim();
    const eventId = String(req.query.eventId || "").trim();
    const regions = String(req.query.regions || "us").trim();
    const bookmakers = String(req.query.bookmakers || "").trim();

    if (!sportKey || !eventId) {
      return res.status(400).json({ error: "sportKey_and_eventId_required" });
    }

    const out = await fetchOddsEventMarkets({
      apiKey: ODDS_KEY,
      sportKey,
      eventId,
      regions,
      bookmakers: bookmakers || null,
      timeoutMs: 12_000,
    });

    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error("[/api/odds/event-markets] error:", e?.message || e);
    return res
      .status(500)
      .json({ error: "server_error", detail: e?.message || String(e) });
  }
});

// --------------------------------------------------
// Odds API — Player Props (event-scoped)
// Notes:
// - Player props markets vary by sport/event/book.
// - If you pass invalid markets, Odds API will return INVALID_MARKET.
// - If `markets` is omitted or set to "auto", we will query the event-markets endpoint first.
// --------------------------------------------------
app.post("/api/odds/event-props", async (req, res) => {
  try {
    const { sportKey, eventId, markets, regions, bookmakers } = req.body || {};

    if (!sportKey || !eventId) {
      return res.status(400).json({ error: "sportKey_and_eventId_required" });
    }

    const out = await fetchOddsEventPlayerProps({
      apiKey: ODDS_KEY,
      sportKey: String(sportKey),
      eventId: String(eventId),
      markets: markets ?? "auto",
      regions: String(regions || "us"),
      bookmakers: bookmakers ? String(bookmakers) : null,
      timeoutMs: 12_000,
    });

    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error("[/api/odds/event-props] error:", e?.message || e);
    return res
      .status(500)
      .json({ error: "server_error", detail: e?.message || String(e) });
  }
});

/**
 * POST /api/bets/refresh
 * body: { userId?: string, daysFrom?: number }
 * Uses Odds API /scores to settle pending bets (h2h/spreads/totals) for the given user.
 */
app.post("/api/bets/refresh", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(400).json({ error: "supabase_not_configured" });
    }

    const userId = String(req.body?.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "missing_userId" });
    }

    const daysFrom = req.body?.daysFrom != null ? Number(req.body.daysFrom) : 7;

    // Load pending/live bets we can settle
    const { data: bets, error } = await supabase
      .from("bets")
      .select("id,user_id,sport,event_name,bet_type,market_key,selection,stake,to_win,status,notes")
      .eq("user_id", userId)
      .in("status", ["pending", "live"]);

    if (error) {
      console.error("[/api/bets/refresh] load bets error:", error);
      return res.status(500).json({ error: "load_bets_failed" });
    }

    const settleable = (bets || []).filter((b) => {
      const mk = String(b.market_key || "");
      return mk === "h2h" || mk === "spreads" || mk === "totals";
    });

    if (!settleable.length) {
      return res.json({ ok: true, updated: 0, checked: 0, message: "no_settleable_open_bets" });
    }

    // Group by Odds sport key
    const bySportKey = new Map();
    for (const b of settleable) {
      const key = inferSportKeyFromBetSport(b.sport);
      if (!key) continue;
      const arr = bySportKey.get(key) || [];
      arr.push(b);
      bySportKey.set(key, arr);
    }

    let checked = 0;
    let updated = 0;
    const details = [];

    for (const [sportKey, group] of bySportKey.entries()) {
      // Fetch recent scores
      const scoresUrl = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores`);
      scoresUrl.searchParams.set("apiKey", ODDS_KEY);
      scoresUrl.searchParams.set("daysFrom", String(daysFrom));
      scoresUrl.searchParams.set("dateFormat", "iso");

      const t = withTimeout(12_000);
      const resp = await fetch(scoresUrl.toString(), { signal: t.signal }).finally(t.cancel);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        console.error("[/api/bets/refresh] scores HTTP error", sportKey, resp.status, txt);
        continue;
      }

      const apiGames = (await resp.json()) ?? [];

      // Index by normalized home|away
      const idx = new Map();
      for (const g of apiGames) {
        const home = g?.home_team;
        const away = g?.away_team;
        if (!home || !away) continue;
        const key = `${normalizeTeamName(home)}|${normalizeTeamName(away)}`;
        idx.set(key, g);
      }

      for (const b of group) {
        checked += 1;
        const ev = parseEventTeams(b.event_name);
        if (!ev?.home || !ev?.away) continue;

        const gameKey = `${normalizeTeamName(ev.home)}|${normalizeTeamName(ev.away)}`;
        const g = idx.get(gameKey);
        if (!g) continue;

        if (!g.completed) {
          // Optionally mark as live if scores are present
          if (Array.isArray(g.scores) && g.scores.length && b.status !== "live") {
            await supabase.from("bets").update({ status: "live" }).eq("id", b.id);
            updated += 1;
          }
          continue;
        }

        // Extract scores
        const homeRow = Array.isArray(g.scores) ? g.scores.find((s) => s.name === g.home_team) : null;
        const awayRow = Array.isArray(g.scores) ? g.scores.find((s) => s.name === g.away_team) : null;

        const homeScore = homeRow?.score != null ? Number(homeRow.score) : null;
        const awayScore = awayRow?.score != null ? Number(awayRow.score) : null;
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

        const mk = String(b.market_key);
        const notes = parseNotesJson(b.notes);

        let result = null; // 'won'|'lost'|'push'

        if (mk === "h2h") {
          // Determine chosen team from selection text.
          const sel = String(b.selection || "");
          const selN = normalizeTeamName(sel);
          const homeN = normalizeTeamName(g.home_team);
          const awayN = normalizeTeamName(g.away_team);

          const choseHome = selN.includes(homeN) || sel.includes(ev.homeTok);
          const choseAway = selN.includes(awayN) || sel.includes(ev.awayTok);

          const winner = homeScore > awayScore ? "home" : awayScore > homeScore ? "away" : "push";
          if (winner === "push") result = "push";
          else if ((winner === "home" && choseHome) || (winner === "away" && choseAway)) result = "won";
          else result = "lost";
        }

        if (mk === "spreads") {
          // Prefer side/line from notes; else parse from selection
          const side = notes?.side || null; // 'home'|'away'
          const ln = notes?.line != null ? Number(notes.line) : null;
          let betSide = side;
          let line = Number.isFinite(ln) ? ln : null;

          if (!betSide || line == null) {
            const parsed = tryParseSpread(String(b.selection || ""));
            if (parsed) {
              line = parsed.line;
              // teamTok should match ev.homeTok/ev.awayTok
              if (String(parsed.teamTok).toUpperCase() === String(ev.homeTok).toUpperCase()) betSide = "home";
              if (String(parsed.teamTok).toUpperCase() === String(ev.awayTok).toUpperCase()) betSide = "away";
            }
          }

          if (!betSide || line == null) {
            // can't grade
            continue;
          }

          const teamScore = betSide === "home" ? homeScore : awayScore;
          const oppScore = betSide === "home" ? awayScore : homeScore;
          const adj = teamScore + line;
          if (adj > oppScore) result = "won";
          else if (adj < oppScore) result = "lost";
          else result = "push";
        }

        if (mk === "totals") {
          const parsed = tryParseTotal(String(b.selection || ""));
          if (!parsed) continue;
          const total = homeScore + awayScore;
          if (parsed.side === "over") {
            if (total > parsed.line) result = "won";
            else if (total < parsed.line) result = "lost";
            else result = "push";
          } else {
            if (total < parsed.line) result = "won";
            else if (total > parsed.line) result = "lost";
            else result = "push";
          }
        }

        if (!result) continue;

        const stake = Number(b.stake) || 0;
        const toWin = Number(b.to_win) || 0;
        const result_amount = result === "won" ? toWin : result === "lost" ? -stake : 0;

        const { error: uErr } = await supabase
          .from("bets")
          .update({ status: result, result_amount, updated_at: new Date().toISOString() })
          .eq("id", b.id);

        if (!uErr) {
          updated += 1;
          details.push({ id: b.id, status: result, result_amount, sportKey });
        }
      }
    }

    return res.json({ ok: true, checked, updated, details });
  } catch (e) {
    console.error("[/api/bets/refresh] error:", e?.message || e);
    return res.status(500).json({ error: "server_error", detail: e?.message || String(e) });
  }
});

// ---- Google Vision OCR (used by BetSync slip parsing) ----
// Expects env var GOOGLE_VISION_SERVICE_ACCOUNT containing a service-account JSON string.
// Example: {"client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseServiceAccount() {
  let raw = mustEnv("GOOGLE_VISION_SERVICE_ACCOUNT");
  raw = String(raw).trim();

  // If the .env value is wrapped in quotes (common), strip them.
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    raw = raw.slice(1, -1);
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error("GOOGLE_VISION_SERVICE_ACCOUNT must be valid JSON");
  }
  if (!obj?.client_email || !obj?.private_key) {
    throw new Error("Service account JSON missing client_email/private_key");
  }
  // JWT/OpenSSL expects a PEM with real newlines. Env files often store literal "\\n".
  const pk = String(obj.private_key)
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n");

  return { client_email: obj.client_email, private_key: pk };
}

async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // Keep a reasonable limit; Vision supports larger, but we don't want huge payloads
  if (buf.length > 8 * 1024 * 1024) throw new Error("Image too large for OCR");
  return buf.toString("base64");
}

async function runVisionOcr({ imageUrl, imageBase64, mode }) {
  const sa = parseServiceAccount();
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const token = await jwt.authorize();
  const accessToken = token?.access_token;
  if (!accessToken) throw new Error("Failed to obtain Google access token");

  const normalizedB64 = imageBase64
    ? String(imageBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
    : null;

  const content = normalizedB64 ?? (await fetchAsBase64(imageUrl));
  const featureType = String(mode || "DOCUMENT_TEXT_DETECTION");

  const visionResp = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          image: { content },
          features: [{ type: featureType }],
        },
      ],
    }),
  });

  const data = await visionResp.json().catch(() => ({}));
  if (!visionResp.ok) {
    const msg = data?.error?.message || "Vision API error";
    const err = new Error(`${msg} (HTTP ${visionResp.status})`);
    err.details = data;
    throw err;
  }

  const r0 = data?.responses?.[0] ?? {};
  const text =
    r0?.fullTextAnnotation?.text ??
    (Array.isArray(r0?.textAnnotations) ? r0.textAnnotations?.[0]?.description : "") ??
    "";

  const textAnnotations = Array.isArray(r0?.textAnnotations) ? r0.textAnnotations : [];

  return {
    mode: featureType,
    text,
    annotations: textAnnotations,
    textAnnotations,
    fullTextAnnotation: r0?.fullTextAnnotation ?? null,
    error: r0?.error ?? null,
  };
}

// Preferred local route
app.post("/api/vision-ocr", async (req, res) => {
  try {
    const { imageUrl, imageBase64, mode } = req.body ?? {};
    const hasUrl = typeof imageUrl === "string" && imageUrl.length > 0;
    const hasB64 = typeof imageBase64 === "string" && imageBase64.length > 0;

    if (!hasUrl && !hasB64) {
      return res.status(400).json({ error: "Missing imageUrl or imageBase64" });
    }

    const out = await runVisionOcr({ imageUrl, imageBase64, mode });
    return res.json(out);
  } catch (e) {
    console.error("[/api/vision-ocr] error:", e?.message || e);
    return res.status(500).json({ error: "vision_ocr_failed", detail: e?.message || String(e) });
  }
});

// Back-compat route (your frontend may call this)
app.post("/api/sleeper/vision-ocr", async (req, res) => {
  try {
    const { imageUrl, imageBase64, mode } = req.body ?? {};
    const out = await runVisionOcr({ imageUrl, imageBase64, mode });
    return res.json(out);
  } catch (e) {
    console.error("[/api/sleeper/vision-ocr] error:", e?.message || e);
    return res.status(500).json({ error: "vision_ocr_failed", detail: e?.message || String(e) });
  }
});

/**
 * GET /api/lines?league=nfl&region=us&markets=spreads,moneyline,totals
 * Returns: { league, games: [...] }
 */
app.get("/api/lines", async (req, res) => {
  try {
    const leagueKey = mapLeague(req.query.league);
    const region = String(req.query.region || "us");
    const markets = mapMarkets(req.query.markets);

    const cacheKey = `${leagueKey}|${region}|${markets}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const url = new URL(
      `https://api.the-odds-api.com/v4/sports/${leagueKey}/odds`
    );
    url.searchParams.set("apiKey", ODDS_KEY);
    url.searchParams.set("regions", region);
    url.searchParams.set("markets", markets);
    url.searchParams.set("oddsFormat", "american");

    const t = withTimeout(12_000);
    const resp = await fetch(url, { signal: t.signal }).finally(t.cancel);

    const xRemaining = resp.headers.get("x-requests-remaining");
    const xUsed = resp.headers.get("x-requests-used");

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({
        error: "upstream_error",
        detail: text,
        meta: { xRemaining, xUsed },
      });
    }

    const raw = await resp.json();

    const games = (raw || []).map((game) => {
      const home = game.home_team;
      const away = game.away_team;

      const book =
        (game.bookmakers || []).find((b) =>
          (b.markets || []).some((m) => m.key === "spreads")
        ) || (game.bookmakers || [])[0];

      const byKey = new Map((book?.markets || []).map((m) => [m.key, m]));
      const mSpreads = byKey.get("spreads");
      const mH2H = byKey.get("h2h");

      let spreadHome = null,
        spreadAway = null;
      if (mSpreads?.outcomes) {
        for (const o of mSpreads.outcomes) {
          if (o.name === home) spreadHome = o.point ?? null;
          if (o.name === away) spreadAway = o.point ?? null;
        }
      }

      const moneyline = {};
      if (mH2H?.outcomes) {
        for (const o of mH2H.outcomes) {
          moneyline[o.name] = o.price;
        }
      }

      return {
        id: game.id,
        commenceTime: game.commence_time,
        home,
        away,
        spreadHome,
        spreadAway,
        moneyline,
        source: book?.title || "unknown",
      };
    });

    // Kick off background sync of scores → Supabase `games` table (PickForge only).
    // Betsync lines for NBA/etc do not need to write into the PickForge `games` table.
    if (String(leagueKey).startsWith("americanfootball_")) {
      syncGamesFromPicks(leagueKey).catch((err) =>
        console.error("[/api/lines] games-sync error:", err)
      );
    }

    const payload = {
      league: leagueKey,
      games,
      meta: { xRemaining, xUsed, fetchedAt: new Date().toISOString() },
    };

    setCache(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("server_error:", msg);
    res.status(500).json({ error: "server_error", detail: msg });
  }
});

/**
 * POST /api/picks
 * body: { league?: "nfl"|"ncaaf", picks: [{ gameId, side: "home"|"away" }] }
 */
app.post("/api/picks", async (req, res) => {
  try {
    const leagueKey = mapLeague(req.body?.league);
    const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];

    if (!picks.length) {
      return res
        .status(400)
        .json({ error: "no_picks", message: "No picks provided" });
    }

    for (const p of picks) {
      if (!p?.gameId || !["home", "away"].includes(p?.side)) {
        return res
          .status(400)
          .json({ error: "bad_pick", message: "Invalid pick shape" });
      }
    }

    const idx = await fetchGamesIndex(leagueKey);
    const now = Date.now();

    const accepted = [];
    const rejected = [];

    for (const p of picks) {
      const meta = idx.get(p.gameId);
      if (!meta) {
        rejected.push({ ...p, reason: "unknown_game" });
        continue;
      }
      const start = new Date(meta.commenceTime).getTime();
      if (now >= start) {
        rejected.push({ ...p, reason: "locked" });
        continue;
      }
      accepted.push({
        ...p,
        commenceTime: meta.commenceTime,
        receivedAt: new Date().toISOString(),
      });
    }

    return res.json({
      serverTime: new Date().toISOString(),
      league: leagueKey,
      accepted,
      rejected,
    });
  } catch (e) {
    console.error("[/api/picks] error:", e?.message || e);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * GET /api/backfill?league=nfl&year=2025&week=15&seasontype=2
 * Backfills historical scores into Supabase `games` using ESPN scoreboard.
 */
app.get("/api/backfill", async (req, res) => {
  try {
    const leagueKey = mapLeague(req.query.league);
    const year = req.query.year != null ? Number(req.query.year) : new Date().getFullYear();
    const week = req.query.week != null ? Number(req.query.week) : null;
    const seasontype = req.query.seasontype != null ? Number(req.query.seasontype) : 2;

    if (week == null || Number.isNaN(week)) {
      return res.status(400).json({ error: "bad_request", message: "week is required" });
    }

    const result = await backfillGamesFromEspn({ leagueKey, year, week, seasontype });
    res.json({ ok: true, league: leagueKey, year, week, seasontype, ...result });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("[/api/backfill] error:", msg);
    res.status(500).json({ error: "server_error", detail: msg });
  }
});

// ------- start -------
app.listen(PORT, () => {
  console.log(` Backend on http://localhost:${PORT}`);
});