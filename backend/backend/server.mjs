import express from "express";
import cors from "cors";

const app = express();
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:5174"] }));

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

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`PickForge API listening on http://localhost:${PORT}`);
});