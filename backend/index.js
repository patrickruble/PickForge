// backend/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

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
  const dbLeague = leagueKey.includes("nfl") ? "nfl" : "ncaaf";

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
    scoresUrl.searchParams.set("daysFrom", "3");      // look ~1 week around today
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

    for (const g of apiGames) {
      const week = weekByGame.get(g.id);
      // Only sync games we actually have picks for
      if (week == null) continue;

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

      // Treat "has real scores" as final even if completed is weird
      const isFinal = g.completed || hasScores;

      rows.push({
        id: g.id,
        league: dbLeague,            // 'nfl' | 'ncaaf'
        week,                        // guaranteed non-null
        home_team: g.home_team,
        away_team: g.away_team,
        kickoff_time: g.commence_time,
        status: isFinal ? "final" : "scheduled",
        home_score: homeScore,
        away_score: awayScore,
      });
    }

    if (!rows.length) {
      console.log("[games-sync] no matching games with scores to upsert.");
      return;
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

    // Kick off background sync of scores → Supabase `games` table
    syncGamesFromPicks(leagueKey).catch((err) =>
      console.error("[/api/lines] games-sync error:", err)
    );

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

    res.json({
      serverTime: new Date().toISOString(),
      league: leagueKey,
      accepted,
      rejected,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ------- start -------
app.listen(PORT, () => {
  console.log(` Backend on http://localhost:${PORT}`);
});