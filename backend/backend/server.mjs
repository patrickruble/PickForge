import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:5174"] }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, server: "server.mjs", ts: Date.now() });
});

// Shape matches your <Game> type
function mockNflGames() {
  return [
    {
      id: "BUF@MIA",
      home: "Dolphins",
      away: "Bills",
      spreadHome: -2.5,
      spreadAway: 2.5,
      source: "mock",
    },
    {
      id: "DAL@PHI",
      home: "Eagles",
      away: "Cowboys",
      spreadHome: -3,
      spreadAway: 3,
      source: "mock",
    },
  ];
}

app.get("/api/lines", (req, res) => {
  const { league = "nfl", markets = "spreads,moneyline" } = req.query;

  // For now we only mock NFL spreads; extend as needed
  const games = league === "nfl" ? mockNflGames() : [];

  res.json({
    league,
    markets: String(markets).split(","),
    games,
    ts: Date.now(),
  });
});

// --------------------------------------------------
// Odds API — Player Props (NFL / NBA)
// --------------------------------------------------
app.post("/api/odds/event-props", async (req, res) => {
  try {
    const { sportKey, eventId, markets } = req.body || {};

    if (!sportKey || !eventId) {
      return res.status(400).json({ error: "sportKey_and_eventId_required" });
    }

    const marketList = Array.isArray(markets)
      ? markets.join(",")
      : typeof markets === "string"
      ? markets
      : "player_points,player_rebounds,player_assists,player_pass_yds,player_rush_yds,player_rec_yds,player_anytime_td";

    const url = new URL(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`
    );

    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", marketList);
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("apiKey", ODDS_API_KEY);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: "odds_api_error", detail: txt });
    }

    const data = await resp.json();

    res.json({
      source: "odds_api",
      sportKey,
      eventId,
      markets: marketList.split(","),
      data,
    });
  } catch (err) {
    console.error("/api/odds/event-props error", err);
    res.status(500).json({ error: "server_error" });
  }
});

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`PickForge API listening on http://localhost:${PORT}`);
});