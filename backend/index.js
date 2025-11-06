// backend/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json()); // ⬅ parse JSON bodies

const ODDS_KEY = process.env.ODDS_API_KEY;
const PORT = process.env.PORT || 8787;

if (!ODDS_KEY) {
  console.error("❌ Missing ODDS_API_KEY in backend/.env");
  process.exit(1);
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
  const parts = String(q || "spreads,h2h").split(",").map(s => s.trim().toLowerCase());
  const mapped = parts.map(m => (m === "moneyline" || m === "ml" ? "h2h" : m));
  // de-dupe & keep only supported
  const allow = new Set(["spreads", "h2h", "totals"]);
  return [...new Set(mapped.filter(m => allow.has(m)))].join(",") || "spreads,h2h";
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
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${leagueKey}/odds`);
  url.searchParams.set("apiKey", ODDS_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "h2h"); // cheap & includes commence_time, teams
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

    const url = new URL(`https://api.the-odds-api.com/v4/sports/${leagueKey}/odds`);
    url.searchParams.set("apiKey", ODDS_KEY);
    url.searchParams.set("regions", region);
    url.searchParams.set("markets", markets); // already includes h2h if requested
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
        meta: { xRemaining, xUsed }
      });
    }

    const raw = await resp.json();

    const games = (raw || []).map(game => {
      const home = game.home_team;
      const away = game.away_team;

      // pick a bookmaker that has spreads if possible, otherwise first
      const book =
        (game.bookmakers || []).find(b => (b.markets || []).some(m => m.key === "spreads")) ||
        (game.bookmakers || [])[0];

      const byKey = new Map((book?.markets || []).map(m => [m.key, m]));
      const mSpreads = byKey.get("spreads");
      const mH2H = byKey.get("h2h"); // moneyline

      let spreadHome = null, spreadAway = null;
      if (mSpreads?.outcomes) {
        for (const o of mSpreads.outcomes) {
          if (o.name === home) spreadHome = o.point ?? null;
          if (o.name === away) spreadAway = o.point ?? null;
        }
      }

      const moneyline = {};
      if (mH2H?.outcomes) {
        for (const o of mH2H.outcomes) {
          moneyline[o.name] = o.price; // american odds
        }
      }

      return {
        id: game.id,
        commenceTime: game.commence_time,
        home,
        away,
        spreadHome,
        spreadAway,
        moneyline,                 // { "Team A": -120, "Team B": +100 }
        source: book?.title || "unknown",
      };
    });

    const payload = {
      league: leagueKey,
      games,
      meta: { xRemaining, xUsed, fetchedAt: new Date().toISOString() }
    };

    setCache(cacheKey, payload); // 30s
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
 * returns: { serverTime, league, accepted: [...], rejected: [...] }
 *
 * NOTE: This does not persist yet—just validates locks. (Step 3 will add DB.)
 */
app.post("/api/picks", async (req, res) => {
  try {
    const leagueKey = mapLeague(req.body?.league);
    const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];

    if (!picks.length) {
      return res.status(400).json({ error: "no_picks", message: "No picks provided" });
    }
    for (const p of picks) {
      if (!p?.gameId || !["home", "away"].includes(p?.side)) {
        return res.status(400).json({ error: "bad_pick", message: "Invalid pick shape" });
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
  console.log(`✅ Backend on http://localhost:${PORT}`);
});