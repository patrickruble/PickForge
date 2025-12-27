import express from "express";
import type { Request, Response } from "express";

// Node 18+ has global fetch. If you prefer node-fetch, you can re-add it.
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

const router = express.Router();

type OddsApiMeta = {
  xRemaining: string | null;
  xUsed: string | null;
};

export type OddsApiError = Error & {
  status?: number;
  meta?: OddsApiMeta;
};

type EventMarketsArgs = {
  sportKey: string;
  eventId: string;
  regions?: string;
};

type PlayerPropsArgs = {
  sportKey: string;
  eventId: string;
  regions?: string;
  markets?: "auto" | string | string[];
};

// Default player prop markets by sport (safe starter list)
const DEFAULT_PLAYER_MARKETS: Record<string, string[]> = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists"],
  // NOTE: NFL player_rec_yds etc can be invalid depending on your plan/region/availability.
  // We'll auto-discover markets first and only request what exists.
  americanfootball_nfl: ["player_pass_yds", "player_rush_yds", "player_rec_yds"],
};

async function oddsFetch(url: string): Promise<{ data: any; meta: OddsApiMeta }> {
  const res = await fetch(url);
  const xRemaining = res.headers.get("x-requests-remaining");
  const xUsed = res.headers.get("x-requests-used");
  const meta: OddsApiMeta = {
    xRemaining: xRemaining != null ? String(xRemaining) : null,
    xUsed: xUsed != null ? String(xUsed) : null,
  };

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: OddsApiError = new Error(text || `Odds API error: ${res.status}`);
    err.status = res.status;
    err.meta = meta;
    throw err;
  }

  const data = await res.json();
  return { data, meta };
}

export async function fetchOddsEventMarkets(args: EventMarketsArgs) {
  const { sportKey, eventId, regions = "us" } = args;
  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) throw new Error("ODDS_API_KEY not set");

  const url = `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}?apiKey=${API_KEY}&regions=${regions}`;
  const { data, meta } = await oddsFetch(url);
  return { bookmakers: data?.bookmakers ?? null, raw: data, meta };
}

export async function fetchOddsEventPlayerProps(args: PlayerPropsArgs) {
  const { sportKey, eventId, markets = "auto", regions = "us" } = args;
  const API_KEY = process.env.ODDS_API_KEY;
  if (!API_KEY) throw new Error("ODDS_API_KEY not set");

  let finalMarkets: string[] = [];

  if (markets === "auto") {
    const { bookmakers } = await fetchOddsEventMarkets({ sportKey, eventId, regions });

    const available = new Set<string>();
    for (const bm of bookmakers ?? []) {
      for (const m of bm.markets ?? []) {
        if (m?.key) available.add(m.key);
      }
    }

    const defaults = DEFAULT_PLAYER_MARKETS[sportKey] ?? [];
    finalMarkets = defaults.filter((m) => available.has(m));

    // If defaults don't exist for this event, fall back to any "player_" markets that are available.
    if (!finalMarkets.length) {
      finalMarkets = Array.from(available).filter((k) => k.startsWith("player_"));
    }
  } else if (Array.isArray(markets)) {
    finalMarkets = markets;
  } else if (typeof markets === "string" && markets.length) {
    // allow comma-separated string
    finalMarkets = markets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (!finalMarkets.length) {
    return {
      markets: [],
      message: "no_player_prop_markets_available_for_event_yet",
      data: null,
    };
  }

  // If caller specified markets (string/array) and Odds API rejects one, we want a graceful fallback.
  // We'll pre-filter against the event's available markets when NOT using `auto`.
  if (markets !== "auto") {
    const { bookmakers } = await fetchOddsEventMarkets({ sportKey, eventId, regions });
    const available = new Set<string>();
    for (const bm of bookmakers ?? []) {
      for (const m of bm.markets ?? []) {
        if (m?.key) available.add(m.key);
      }
    }

    // Keep only markets the event actually exposes.
    const filtered = finalMarkets.filter((m) => available.has(m));

    // If nothing survives filtering, fall back to any available player_ markets.
    finalMarkets = filtered.length ? filtered : Array.from(available).filter((k) => k.startsWith("player_"));

    if (!finalMarkets.length) {
      return {
        markets: [],
        message: "no_player_prop_markets_available_for_event_yet",
        data: null,
      };
    }
  }

  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/events/${eventId}/odds` +
    `?apiKey=${API_KEY}` +
    `&regions=${regions}` +
    `&markets=${encodeURIComponent(finalMarkets.join(","))}`;

  const { data, meta } = await oddsFetch(url);
  return { markets: finalMarkets, data, meta };
}

// GET /event-markets  (router should be mounted at /api/odds in index/server)
router.get("/event-markets", async (req: Request, res: Response) => {
  try {
    const sportKey = String(req.query.sportKey || "");
    const eventId = String(req.query.eventId || "");
    const regions = String(req.query.regions || "us");

    if (!sportKey || !eventId) {
      return res.status(400).json({ error: "missing_parameters", detail: "sportKey and eventId are required" });
    }

    const result = await fetchOddsEventMarkets({ sportKey, eventId, regions });

    return res.json({
      ok: true,
      sportKey,
      eventId,
      regions,
      bookmakers: result.bookmakers,
      meta: result.meta,
      raw: JSON.stringify(result.raw),
    });
  } catch (err: unknown) {
    const e = err as OddsApiError;
    return res.status(500).json({
      error: "odds_api_error",
      detail: e.message,
      ...(e.meta ? { meta: e.meta } : {}),
    });
  }
});

// POST /event-props  (router should be mounted at /api/odds in index/server)
router.post("/event-props", async (req: Request, res: Response) => {
  try {
    const { sportKey, eventId, regions = "us", markets } = (req.body ?? {}) as any;

    if (!sportKey || !eventId) {
      return res.status(400).json({ error: "missing_parameters", detail: "sportKey and eventId are required" });
    }

    const result = await fetchOddsEventPlayerProps({ sportKey, eventId, regions, markets });

    if (result.data == null) {
      return res.json({
        source: "odds_api",
        sportKey,
        eventId,
        regions,
        markets: result.markets,
        available_markets: [],
        message: result.message,
      });
    }

    return res.json({
      source: "odds_api",
      sportKey,
      eventId,
      regions,
      markets: result.markets,
      data: result.data,
      meta: result.meta,
    });
  } catch (err: unknown) {
    const e = err as OddsApiError;
    return res.status(500).json({
      error: "odds_api_error",
      detail: e.message,
      ...(e.meta ? { meta: e.meta } : {}),
    });
  }
});

export default router;
