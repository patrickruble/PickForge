import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { MarketType, ParsedSlip, SideType } from "./types/parsedSlip";
import { parseSlipFromOcr } from "./parseSlipFromOcr";

type BetSlipRow = {
  id: string;
  user_id: string;
  status: string | null;
  image_path: string | null;
  parsed: ParsedSlip | null;
  raw_ocr: any | null;
};

type EditableBet = {
  market_type: MarketType;
  market_key: string | null;
  selection_text: string;
  odds_american: number | null;
  sport: string | null;
  league: string | null;
  event: string | null;
  event_date: string | null;
  side: SideType;
  line: number | null;
  confidence: number; // 0..1
  issues: string[];

  // fields for DB insert
  stake: number | null;
  to_win: number | null;
};

const MARKET_TYPE_OPTIONS = [
  "moneyline",
  "moneyline_parlay",
  "spread",
  "spread_parlay",
  "total",
  "total_parlay",
  "team_total",
  "team_total_parlay",
  "player_prop",
  "player_prop_parlay",
  "game_prop",
  "game_prop_parlay",
  "first_td",
  "first_td_parlay",
  "anytime_td",
  "anytime_td_parlay",
  "alt_line",
  "alt_line_parlay",
  "future",
  "parlay",
  "other",
] as const;

function safeNumber(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function inferAmericanOddsFromStakeToWin(stake: number | null, toWin: number | null): number | null {
  // Assumes `toWin` is PROFIT ("to win"), not total payout.
  if (stake == null || toWin == null) return null;
  if (!Number.isFinite(stake) || !Number.isFinite(toWin)) return null;
  if (stake <= 0 || toWin <= 0) return null;

  const profit = toWin;
  const dec = 1 + profit / stake; // decimal odds
  if (!Number.isFinite(dec) || dec <= 1) return null;

  // Convert decimal odds to American odds
  if (dec >= 2) {
    return Math.round((dec - 1) * 100);
  }
  return -Math.round(100 / (dec - 1));
}

type OddsEventPropsResponse = {
  source: string;
  sportKey: string;
  eventId: string;
  regions: string;
  markets: string[];
  data: any;
};

type NormalizedPropLine = {
  book: string;
  market: string;
  player: string;
  side: "Over" | "Under" | string;
  line: number | null;
  price: number | null;
  last_update?: string | null;
};

function normalizeEventProps(resp: OddsEventPropsResponse | null): NormalizedPropLine[] {
  if (!resp?.data?.bookmakers) return [];
  const out: NormalizedPropLine[] = [];

  for (const bm of resp.data.bookmakers ?? []) {
    const bookTitle = bm?.title ?? bm?.key ?? "Unknown";
    for (const m of bm?.markets ?? []) {
      const marketKey = m?.key ?? "unknown";
      const lastUpdate = m?.last_update ?? null;
      for (const o of m?.outcomes ?? []) {
        out.push({
          book: String(bookTitle),
          market: String(marketKey),
          player: String(o?.description ?? ""),
          side: String(o?.name ?? ""),
          line: typeof o?.point === "number" ? o.point : safeNumber(o?.point),
          price: typeof o?.price === "number" ? o.price : safeNumber(o?.price),
          last_update: typeof lastUpdate === "string" ? lastUpdate : null,
        });
      }
    }
  }

  // Sort: player, market, book, side
  out.sort((a, b) =>
    (a.player || "").localeCompare(b.player || "") ||
    (a.market || "").localeCompare(b.market || "") ||
    (a.book || "").localeCompare(b.book || "") ||
    (a.side || "").localeCompare(b.side || "")
  );

  return out;
}

export default function ReviewSlip() {
  const { slipId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slip, setSlip] = useState<BetSlipRow | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [betsDraft, setBetsDraft] = useState<EditableBet[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<number>(0);
  const [ocrText, setOcrText] = useState<string>("");
  const [parsedOverride, setParsedOverride] = useState<ParsedSlip | null>(null);
  const ocrWorkerLoadedRef = useRef(false);

  // Odds lookup state
  const [oddsSportKey, setOddsSportKey] = useState<string>("basketball_nba");
  const [oddsEventId, setOddsEventId] = useState<string>("");
  const [oddsRegions, setOddsRegions] = useState<string>("us");
  const [oddsMarkets, setOddsMarkets] = useState<string>("auto");
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const [oddsResp, setOddsResp] = useState<OddsEventPropsResponse | null>(null);

  const normalizedProps = useMemo(() => normalizeEventProps(oddsResp), [oddsResp]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!slipId) {
        setError("Missing slipId in URL.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      const { data, error: qErr } = await supabase
        .from("bet_slips")
        .select("id, user_id, status, image_path, parsed, raw_ocr")
        .eq("id", slipId)
        .maybeSingle();

      if (cancelled) return;

      if (qErr) {
        console.error("[ReviewSlip] load error", qErr);
        setError(qErr.message);
        setSlip(null);
        setImageUrl(null);
        setLoading(false);
        return;
      }

      const row: BetSlipRow | null = (data as BetSlipRow) ?? null;
      setSlip(row);
      setParsedOverride(null);
      // Hydrate OCR preview if present
      const existingText = (row as any)?.raw_ocr?.text;
      if (typeof existingText === "string") setOcrText(existingText);
      else setOcrText("");

      // Build a signed URL for private bucket previews
      if (row?.image_path) {
        const { data: signed, error: signErr } = await supabase.storage
          .from("bet-slips")
          .createSignedUrl(row.image_path, 60 * 10);

        if (signErr) {
          console.error("[ReviewSlip] signed url error", signErr);
          setImageUrl(null);
        } else {
          setImageUrl(signed?.signedUrl ?? null);
        }
      } else {
        setImageUrl(null);
      }

      setLoading(false);
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [slipId]);

  const parsed: ParsedSlip = useMemo(() => {
    return (
      parsedOverride ??
      slip?.parsed ?? {
        bets: [],
        meta: { parser_version: "dev", source: "stub" },
      }
    );
  }, [slip, parsedOverride]);
  async function handleParseToDraft() {
    if (!slip) return;

    const text = (ocrText ?? "").trim();
    if (!text) {
      setError("Run OCR first (no OCR text found).");
      return;
    }

    try {
      setError(null);
      setConfirmMsg(null);

      const raw = (slip as any)?.raw_ocr ?? null;
      const annotations = raw?.annotations ?? raw?.textAnnotations ?? [];


      const ocrInput = {
        text,
        annotations: Array.isArray(annotations) ? annotations : [],
        textAnnotations: Array.isArray(annotations) ? annotations : [],
      };

      const nextParsed = parseSlipFromOcr(ocrInput as any);

      if (!nextParsed.meta) {
        nextParsed.meta = {
          parser_version: "dev",
          source: "ocr",
        };
      }
      // Optional debug hint (not part of the typed meta.source union)
      if (raw?.engine) {
        (nextParsed as any).meta = { ...(nextParsed as any).meta, engine: String(raw.engine) };
      }

      // Update UI immediately
      setParsedOverride(nextParsed);

      // Persist so refresh keeps it
      const { error: updErr } = await supabase
        .from("bet_slips")
        .update({ parsed: nextParsed, status: "parsed" })
        .eq("id", slip.id);

      if (updErr) console.warn("[ReviewSlip] could not persist parsed slip", updErr);

      setConfirmMsg("Parsed from OCR. Review & edit, then Confirm.");
    } catch (e: any) {
      console.error("[ReviewSlip] parse failed", e);
      setError(e?.message ?? "Parse failed.");
    }

  }

  const handleFetchEventProps = useCallback(async () => {
    const eventId = (oddsEventId ?? "").trim();
    const sportKey = (oddsSportKey ?? "").trim();
    const regions = (oddsRegions ?? "us").trim() || "us";
    const markets = (oddsMarkets ?? "auto").trim() || "auto";

    if (!sportKey) {
      setOddsError("Missing sportKey (example: basketball_nba). ");
      return;
    }
    if (!eventId) {
      setOddsError("Missing eventId.");
      return;
    }

    try {
      setOddsLoading(true);
      setOddsError(null);

      const res = await fetch("/api/odds/event-props", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sportKey, eventId, markets, regions }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Odds fetch failed (${res.status}) ${txt}`.trim());
      }

      const json = (await res.json()) as OddsEventPropsResponse;
      setOddsResp(json);
    } catch (e: any) {
      console.error("[ReviewSlip] odds fetch failed", e);
      setOddsResp(null);
      setOddsError(e?.message ?? "Odds fetch failed.");
    } finally {
      setOddsLoading(false);
    }
  }, [oddsEventId, oddsSportKey, oddsRegions, oddsMarkets]);

  // --- Player prop/moneyline normalization helpers ---
  const looksLikePlayerProp = (s: string) => {
    const t = (s ?? "").toLowerCase();
    return (
      t.includes("to record") ||
      t.includes("double double") ||
      t.includes("triple double") ||
      t.includes("points") ||
      t.includes("rebounds") ||
      t.includes("assists") ||
      t.includes("threes") ||
      t.includes("three") ||
      t.includes("blocks") ||
      t.includes("steals")
    );
  };

  const inferPropMarketKeyFromSelection = (s: string): string | null => {
    const t = (s ?? "").toLowerCase();

    // Combo props first
    if (t.includes("points") && t.includes("rebounds") && t.includes("assists")) return "player_points_rebounds_assists";
    if (t.includes("points") && t.includes("rebounds")) return "player_points_rebounds";
    if (t.includes("points") && t.includes("assists")) return "player_points_assists";
    if (t.includes("rebounds") && t.includes("assists")) return "player_rebounds_assists";

    // Common player prop stats
    if (t.includes("points") || t.includes("pts")) return "player_points";
    if (t.includes("rebounds") || t.includes("rebs") || t.includes("reb")) return "player_rebounds";
    if (t.includes("assists") || t.includes("asts") || t.includes("ast")) return "player_assists";
    if (t.includes("threes") || t.includes("three") || t.includes("3pt") || t.includes("3 pt")) return "player_threes";
    if (t.includes("blocks") || t.includes("blk")) return "player_blocks";
    if (t.includes("steals") || t.includes("stl")) return "player_steals";

    // Milestones
    if (t.includes("double double")) return "player_double_double";
    if (t.includes("triple double")) return "player_triple_double";

    // Generic player prop
    if (looksLikePlayerProp(s)) return "player_props";

    return null;
  };

  const normalizeMarketTypeFromSelection = (mt: MarketType, sel: string): MarketType => {
    // If the parser mislabeled a prop as a moneyline (common in pending lists), correct it.
    if (looksLikePlayerProp(sel)) {
      if (mt === "moneyline") return "player_prop";
      if (mt === "moneyline_parlay") return "player_prop_parlay";
      // Sometimes parser falls back to generic parlay/other
      if (mt === "parlay") return "player_prop_parlay";
    }
    return mt;
  };

  useEffect(() => {
    // Initialize editable rows when slip/parsed changes
    const baseWager = safeNumber(parsed.wager);
    const baseToWin = safeNumber(parsed.to_win);
    const legs = parsed.bets?.length ?? 0;

    // Parlay detection: use slip-level wager/to_win only for parlays or explicit parlay legs
    const isParlay =
      parsed.bet_style === "parlay" ||
      (Array.isArray(parsed.bets) &&
        parsed.bets.length > 1 &&
        parsed.bets.every((x: any) => x?.kind === "parlay_leg"));

    const perLegStake =
      isParlay && baseWager != null && legs > 0
        ? Math.round((baseWager / legs) * 100) / 100
        : null;
    const perLegToWin =
      isParlay && baseToWin != null && legs > 0
        ? Math.round((baseToWin / legs) * 100) / 100
        : null;

    // Prefer per-bet amounts if the parser extracted them; otherwise fall back to per-leg split.
    const asMoney = (v: any): number | null => {
      if (v == null) return null;
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      const cleaned = String(v).replace(/[^0-9.]/g, "");
      if (!cleaned) return null;
      const n = parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
    };


    const rows: EditableBet[] = (parsed.bets ?? []).map((b) => ({
      market_type: normalizeMarketTypeFromSelection(((b.market_type ?? "other") as MarketType), b.selection_text ?? ""),
      market_key: (() => {
        const mk = (b as any).market_key ?? null;
        const mt = normalizeMarketTypeFromSelection(((b.market_type ?? "other") as MarketType), b.selection_text ?? "");
        // If market_key is missing or generic, infer from selection text.
        if ((mk == null || mk === "props" || mk === "player_props") && String(mt).includes("player_prop")) {
          return inferPropMarketKeyFromSelection(b.selection_text ?? "") ?? mk;
        }
        return mk;
      })(),
      selection_text: b.selection_text ?? "",
      odds_american: (() => {
        const extracted = safeNumber((b as any).odds_american ?? b.odds_american);
        const stakeCandidate = asMoney((b as any).stake);
        const toWinCandidate = asMoney((b as any).to_win);
        const inferred = inferAmericanOddsFromStakeToWin(stakeCandidate, toWinCandidate);

        const issues = Array.isArray((b as any).issues) ? (b as any).issues : [];
        const missingOdds = issues.includes("missing_odds");

        // If parser didn't find odds (or marked missing), infer from stake/to_win.
        if ((extracted == null || missingOdds) && inferred != null) return inferred;

        // Common placeholder: -110 when odds are actually unknown.
        if (extracted === -110 && missingOdds && inferred != null) return inferred;

        return extracted;
      })(),
      sport: b.sport ?? null,
      league: b.league ?? null,
      event: b.event ?? null,
      event_date: b.event_date ?? null,
      side: (b.side ?? null) as SideType,
      line: b.line ?? null,
      confidence: typeof b.confidence === "number" ? b.confidence : 0,
      issues: Array.isArray(b.issues) ? b.issues : [],
      stake: asMoney((b as any).stake) ?? (isParlay ? null : null),
      to_win: asMoney((b as any).to_win) ?? (isParlay ? null : null),
    }));

    setBetsDraft(rows);
    setConfirmMsg(null);
  }, [parsed]);

  async function handleDelete() {
    if (!slip) return;
    const ok = window.confirm(
      "Delete this slip and its image? This cannot be undone."
    );
    if (!ok) return;

    try {
      setDeleting(true);
      setError(null);

      // 1) delete the storage object (ignore if missing)
      if (slip.image_path) {
        const { error: rmErr } = await supabase.storage
          .from("bet-slips")
          .remove([slip.image_path]);
        if (rmErr) console.warn("[ReviewSlip] storage remove error", rmErr);
      }

      // 2) delete the slip row
      const { error: delErr } = await supabase
        .from("bet_slips")
        .delete()
        .eq("id", slip.id);

      if (delErr) throw delErr;

      navigate("/bets/upload");
    } catch (e: any) {
      console.error("[ReviewSlip] delete failed", e);
      setError(e?.message ?? "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }

  async function handleConfirm() {
    if (!slip) return;
    if (!betsDraft.length) {
      setError("No parsed bets found to confirm.");
      return;
    }

    // Basic validation: selection + market_type
    const badIdx = betsDraft.findIndex(
      (b) => !b.selection_text.trim() || !b.market_type
    );
    if (badIdx !== -1) {
      setError(`Bet #${badIdx + 1} is missing required fields.`);
      return;
    }

    try {
      setConfirming(true);
      setError(null);
      setConfirmMsg(null);

      const { data: authData, error: authErr } = await supabase.auth.getUser();
      if (authErr) throw authErr;
      const authedUserId = authData?.user?.id;
      if (!authedUserId) throw new Error("You must be signed in.");

      if (slip.user_id !== authedUserId) {
        throw new Error("You can only confirm your own slips.");
      }

      const book = parsed.book ?? null;

      const isParlay =
        parsed.bet_style === "parlay" ||
        (Array.isArray(parsed.bets) &&
          parsed.bets.length > 1 &&
          parsed.bets.every((x) => x?.kind === "parlay_leg"));
      // Persist the edited draft back into bet_slips.parsed so a refresh keeps the reviewed values.
      const reviewedParsed: ParsedSlip = {
        ...parsed,
        bet_style: parsed.bet_style ?? (isParlay ? "parlay" : null),
        legs_count: parsed.legs_count ?? (isParlay ? betsDraft.length : null),
        bets: betsDraft.map((b) => ({
          kind: isParlay ? ("parlay_leg" as const) : ("single" as const),
          sport: b.sport ?? null,
          league: b.league ?? null,
          event: b.event ?? null,
          event_date: b.event_date ?? null,
          home_team: null,
          away_team: null,
          market_type: b.market_type,
          market_key: b.market_key ?? null,
          market_text: null,
          selection_text: b.selection_text,
          player: null,
          stat: null,
          period: null,
          line: b.line ?? null,
          side: b.side ?? null,
          team: null,
          odds_american: b.odds_american ?? null,
          is_alt: null,
          is_live: null,
          confidence: Number.isFinite(b.confidence) ? b.confidence : 0,
          issues: Array.isArray(b.issues) ? b.issues : [],
        })),
        meta: parsed.meta ?? { parser_version: "dev", source: "ocr" },
      };

      // Best-effort: save reviewedParsed before inserting bets (do not block confirm on this)
      const { error: saveReviewedErr } = await supabase
        .from("bet_slips")
        .update({ parsed: reviewedParsed })
        .eq("id", slip.id);
      if (saveReviewedErr) {
        console.warn("[ReviewSlip] could not persist reviewed parsed slip", saveReviewedErr);
      }


      const slipStake = safeNumber(parsed.wager);
      const slipToWin = safeNumber(parsed.to_win);

      const avgConf =
        betsDraft.length > 0
          ? Math.max(
              0,
              Math.min(
                1,
                betsDraft.reduce((s, b) => s + (Number.isFinite(b.confidence) ? b.confidence : 0), 0) /
                  betsDraft.length
              )
            )
          : 0;

      function buildParlaySummary(legs: EditableBet[]): string {
        // Keep it readable in the `selection` column
        const lines = legs
          .map((l, i) => {
            const odds = l.odds_american != null ? ` @${l.odds_american}` : "";
            return `${i + 1}) ${l.selection_text.trim() || "(missing selection)"}${odds}`;
          })
          .join(" | ");
        return `Parlay (${legs.length} legs): ${lines}`.slice(0, 5000);
      }

      const inserts = isParlay
        ? [
            {
              user_id: authedUserId,
              slip_id: slip.id,
              sport: (betsDraft[0]?.league ?? betsDraft[0]?.sport ?? "Unknown") as string,
              book_name: book,
              event_name: parsed.ticket_no ? `Parlay ${parsed.ticket_no}` : "Parlay",
              event_date: parsed.placed_at ? new Date(parsed.placed_at).toISOString() : null,
              bet_type: "parlay",
              market_key: null,
              selection: buildParlaySummary(betsDraft),
              odds_american: safeNumber(parsed.odds_american) ?? 0,
              stake: slipStake ?? 0,
              to_win: slipToWin ?? 0,
              status: "pending" as const,
              result_amount: 0,
              confidence: Math.max(1, Math.min(5, Math.round(avgConf * 5))),
              notes: JSON.stringify(
                {
                  kind: "parlay",
                  slip_id: slip.id,
                  slip_image_path: slip.image_path ?? null,
                  ticket_no: parsed.ticket_no ?? null,
                  placed_at: parsed.placed_at ?? null,
                  wager: slipStake ?? null,
                  to_win: slipToWin ?? null,
                  legs: betsDraft.map((l) => ({
                    market_type: l.market_type,
                    market_key: l.market_key ?? null,
                    selection_text: l.selection_text,
                    odds_american: l.odds_american,
                    league: l.league,
                    sport: l.sport,
                    event: l.event,
                    event_date: l.event_date,
                    side: l.side,
                    line: l.line,
                    issues: l.issues,
                    confidence: l.confidence,
                  })),
                },
                null,
                0
              ),
            },
          ]
        : betsDraft.map((b) => {
            const eventName =
              b.event?.trim() || b.selection_text.trim() || parsed.ticket_no || "Bet";

            // bet_type column in DB expects text; we store our normalized market_type
            const betType = b.market_type;

            return {
              user_id: authedUserId,
              slip_id: slip.id,
              sport: (b.league ?? b.sport ?? "Unknown") as string,
              book_name: book,
              event_name: eventName,
              event_date: b.event_date ? new Date(b.event_date).toISOString() : null,
              bet_type: betType,
              market_key: b.market_key ?? null,
              selection: b.selection_text.trim(),
              odds_american: b.odds_american ?? 0,
              stake: b.stake ?? 0,
              to_win: b.to_win ?? 0,
              status: "pending" as const,
              result_amount: 0,
              confidence:
                Number.isFinite(b.confidence) && b.confidence >= 0
                  ? Math.max(1, Math.min(5, Math.round(b.confidence * 5)))
                  : null,
              notes: JSON.stringify(
                {
                  kind: "single",
                  slip_id: slip.id,
                  slip_image_path: slip.image_path ?? null,
                  ticket_no: parsed.ticket_no ?? null,
                  placed_at: parsed.placed_at ?? null,
                  market_type: b.market_type,
                  market_key: b.market_key ?? null,
                  selection_text: b.selection_text,
                  odds_american: b.odds_american ?? null,
                  league: b.league ?? null,
                  sport: b.sport ?? null,
                  event: b.event ?? null,
                  event_date: b.event_date ?? null,
                  side: b.side,
                  line: b.line,
                  issues: b.issues,
                  confidence: b.confidence,
                },
                null,
                0
              ),
            };
          });

      const { error: insErr } = await supabase.from("bets").insert(inserts);
      if (insErr) throw insErr;

      // Optionally mark slip as confirmed and save reviewed parsed slip as well; ignore errors
      const { error: updErr } = await supabase
        .from("bet_slips")
        .update({ status: "confirmed", parsed: reviewedParsed })
        .eq("id", slip.id);
      if (updErr) {
        console.warn("[ReviewSlip] could not update slip status", updErr);
      }

      setConfirmMsg(
        isParlay
          ? `Confirmed 1 parlay (${betsDraft.length} legs) into Bets.`
          : `Confirmed ${inserts.length} bet(s) into Bets.`
      );
    } catch (e: any) {
      console.error("[ReviewSlip] confirm failed", e);
      setError(e?.message ?? "Confirm failed.");
    } finally {
      setConfirming(false);
    }
  }

  async function handleRunOcr() {
    if (!slip) return;
    if (!slip.image_path) {
      setError("This slip has no image to OCR.");
      return;
    }

    try {
      setOcrRunning(true);
      setOcrProgress(0);
      setError(null);
      setConfirmMsg(null);

      // Refresh a signed URL (in case the existing one expired)
      const { data: signed, error: signErr } = await supabase.storage
        .from("bet-slips")
        .createSignedUrl(slip.image_path, 60 * 10);
      if (signErr) throw signErr;

      const signedUrl = signed?.signedUrl;
      if (!signedUrl) throw new Error("Could not create a signed URL for the slip image.");

      const countMoney = (s: string) => ((s ?? "").match(/\$\s*\d/g) ?? []).length;

      let visionText: string | null = null;
      let visionAnnotations: any[] = [];
      let visionMode: string | null = null;
      let visionOk = false;
      let visionEndpointUsed: string | null = null;
      // --- Prefer Google Vision OCR (better at colored/small digits like BetMASS Risk) ---
      try {
        const visionEndpoints = ["/api/vision-ocr", "/api/sleeper/vision-ocr"]; // backend may expose either
        const visionModes = ["TEXT_DETECTION", "DOCUMENT_TEXT_DETECTION"] as const;
        let visionResp: Response | null = null;

        for (const ep of visionEndpoints) {
          for (const m of visionModes) {
            const r = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                imageUrl: signedUrl,
                // Try TEXT_DETECTION first for small digits; fall back to DOCUMENT_TEXT_DETECTION.
                mode: m,
                debug: false,
              }),
            });
            visionResp = r;
            if (r.ok) {
              visionEndpointUsed = ep;
              visionMode = m;
              break;
            }
          }
          if (visionResp?.ok) break;
        }

        if (!visionResp) throw new Error("Vision OCR: no response");

        if (visionResp.ok) {
          const v = await visionResp.json();
          const vText = (v?.text ?? "").trim();
          const vAnnotations = Array.isArray(v?.annotations)
            ? v.annotations
            : Array.isArray(v?.textAnnotations)
              ? v.textAnnotations
              : [];

          const annCount = Array.isArray(vAnnotations) ? vAnnotations.length : 0;

          // Vision can return empty top-level text but still provide useful word boxes.
          if (vText || annCount > 0) {
            visionOk = true;
            visionText = vText || null;
            visionAnnotations = vAnnotations;

            // Only overwrite the visible OCR text if Vision actually produced text.
            if (vText) setOcrText(vText);

            setConfirmMsg("OCR pulled (Google Vision). Enhancing if needed…");
          }
        } else {
          const err = await visionResp.text().catch(() => "");
          console.warn("[ReviewSlip] Vision OCR failed via", visionEndpointUsed ?? "(none)", "status", visionResp.status, err);
        }
      } catch (e) {
        console.warn("[ReviewSlip] Vision OCR error; falling back", e);
      }

      // Fetch image as blob
      const resp = await fetch(signedUrl);
      if (!resp.ok) throw new Error(`Failed to download image (${resp.status}).`);
      const blob = await resp.blob();
      // If Vision succeeded, use its text as the base. We'll still run the Risk-column enhancement if money is missing.
      if (visionOk && visionText) {
        setOcrText(visionText);
      }

      // --- BetMASS Pending List: layout-aware OCR helpers (TSV) ---
      const looksLikeBetmassPending = (t: string) => {
        const s = (t ?? "").toLowerCase();
        return (
          s.includes("pending") &&
          s.includes("description") &&
          s.includes("risk") &&
          (s.includes("to win") || (s.includes("to") && s.includes("win")))
        );
      };

      type TsvWord = {
        text: string;
        left: number;
        top: number;
        width: number;
        height: number;
        line: number;
        conf: number;
      };

      const parseTsvWords = (
        tsv: string,
        offsetLeft = 0,
        offsetTop = 0,
        scale = 1
      ): TsvWord[] => {
        const out: TsvWord[] = [];
        const rows = (tsv ?? "").split(/\r?\n/);
        const s = Number.isFinite(scale) && scale > 0 ? scale : 1;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;
          const cols = row.split("\t");
          if (cols.length < 12) continue;

          const level = Number(cols[0]);
          if (level !== 5) continue; // word-level boxes

          const left = Number(cols[6]);
          const top = Number(cols[7]);
          const width = Number(cols[8]);
          const height = Number(cols[9]);
          const conf = Number(cols[10]);
          const text = (cols[11] ?? "").trim();
          const lineNum = Number(cols[4]);

          if (!text) continue;
          if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
            continue;
          }

          // Unscale crop coordinates back to the original image space before applying offsets.
          const uLeft = left / s;
          const uTop = top / s;
          const uWidth = width / s;
          const uHeight = height / s;

          out.push({
            text,
            left: uLeft + offsetLeft,
            top: uTop + offsetTop,
            width: uWidth,
            height: uHeight,
            line: Number.isFinite(lineNum) ? lineNum : 0,
            conf: Number.isFinite(conf) ? conf : 0,
          });
        }
        return out;
      };

      const isNumericToken = (t: string) => {
        const s = (t ?? "").replace(/,/g, "");
        return /^\$?\d+(?:\.\d{1,2})?$/.test(s);
      };

      const toMoneyNum = (t: string): number | null => {
        const s = (t ?? "").replace(/,/g, "").replace(/\$/g, "");
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };

      const inferMoneyColumns = (
        words: TsvWord[]
      ): { riskMin: number; riskMax: number; winMin: number; winMax: number } | null => {
        if (!words.length) return null;
        const pageWidth = Math.max(...words.map((w) => w.left + w.width));

        // Candidate money tokens: numeric-ish tokens on the right half of the page.
        const money = words
          .filter((w) => isNumericToken(w.text))
          .filter((w) => w.left > pageWidth * 0.45)
          .sort((a, b) => a.left - b.left);

        if (money.length < 4) return null;

        // Split into two clusters by the largest gap in x (Risk column then To Win column).
        let bestGap = 0;
        let splitAt = -1;
        for (let i = 0; i < money.length - 1; i++) {
          const gap = money[i + 1].left - money[i].left;
          if (gap > bestGap) {
            bestGap = gap;
            splitAt = i;
          }
        }

        if (splitAt === -1 || bestGap < 20) return null;

        const leftCluster = money.slice(0, splitAt + 1);
        const rightCluster = money.slice(splitAt + 1);
        if (leftCluster.length < 2 || rightCluster.length < 2) return null;

        const riskMin = Math.min(...leftCluster.map((w) => w.left)) - 10;
        const riskMax = Math.max(...leftCluster.map((w) => w.left + w.width)) + 10;
        const winMin = Math.min(...rightCluster.map((w) => w.left)) - 10;
        const winMax = Math.max(...rightCluster.map((w) => w.left + w.width)) + 10;

        return { riskMin, riskMax, winMin, winMax };
      };

      const rebuildBetmassPendingTextFromWords = (words: TsvWord[]): string | null => {
        if (!words.length) return null;

        const cols = inferMoneyColumns(words);
        if (!cols) return null;

        // Group words by approximate visual line using top coordinate buckets.
        // This is more reliable than TSV line numbers across separate OCR passes.
        const sorted = words.slice().sort((a, b) => a.top - b.top || a.left - b.left);
        const lines: { top: number; words: TsvWord[] }[] = [];
        const THRESH = 14; // px tolerance for same line

        for (const w of sorted) {
          const last = lines[lines.length - 1];
          if (!last || Math.abs(w.top - last.top) > THRESH) {
            lines.push({ top: w.top, words: [w] });
          } else {
            last.words.push(w);
          }
        }

        const outLines: string[] = [];

        for (const line of lines) {
          const ws = line.words.slice().sort((a, b) => a.left - b.left);
          const fullText = ws
            .map((w) => w.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (!fullText) continue;

          const low = fullText.toLowerCase();
          if (low === "pending" || low === "transactions" || low === "figures") continue;
          if (
            low.includes("description") &&
            low.includes("risk") &&
            (low.includes("to win") || (low.includes("to") && low.includes("win")))
          ) {
            continue;
          }

          const ticketMatch = fullText.match(/\b(\d{9})\b/);
          const ticketNo = ticketMatch?.[1] ?? null;

          // Description area = everything left of the risk column.
          const descTokens = ws.filter((w) => w.left < cols.riskMin - 5);
          const desc = descTokens
            .map((w) => w.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          const riskTokens = ws.filter(
            (w) => w.left >= cols.riskMin && w.left <= cols.riskMax && isNumericToken(w.text)
          );
          const winTokens = ws.filter(
            (w) => w.left >= cols.winMin && w.left <= cols.winMax && isNumericToken(w.text)
          );

          const risk = riskTokens.length ? toMoneyNum(riskTokens[riskTokens.length - 1].text) : null;
          const toWin = winTokens.length ? toMoneyNum(winTokens[winTokens.length - 1].text) : null;

          if (ticketNo) {
            const moneyPart =
              risk != null && toWin != null
                ? ` $${risk} $${toWin}`
                : risk != null
                  ? ` $${risk}`
                  : toWin != null
                    ? ` $${toWin}`
                    : "";

            outLines.push(`${ticketNo} | Basketball NBA${moneyPart}`.trim());

            const remainder = (desc || fullText)
              .replace(ticketNo, "")
              .replace(/\|\s*Basketball\s+NBA/i, "")
              .replace(/\s+/g, " ")
              .trim();
            if (remainder) outLines.push(remainder);
          } else {
            outLines.push(desc || fullText);
          }
        }

        const rebuilt = outLines.filter(Boolean).join("\n").trim();
        return rebuilt || null;
      };
      async function cropBlobXPx(
        input: Blob,
        x0Px: number,
        x1Px: number,
        scale = 3
      ): Promise<{ blob: Blob; offsetLeft: number; width: number; height: number; scale: number } | null> {
        const bmp = await createImageBitmap(input);
        const w = bmp.width;
        const h = bmp.height;

        const x0 = Math.max(0, Math.min(w - 1, Math.floor(x0Px)));
        const x1 = Math.max(x0 + 1, Math.min(w, Math.floor(x1Px)));
        const cw = Math.max(1, x1 - x0);

        const canvas = document.createElement("canvas");
        canvas.width = cw * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        // Upscale crop to help Tesseract with small digits
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bmp, x0, 0, cw, h, 0, 0, cw * scale, h * scale);

        const outBlob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png")
        );
        if (!outBlob) return null;
        return { blob: outBlob, offsetLeft: x0, width: cw, height: h, scale };
      }

      // Helper: count 9-digit ticket numbers in a string
      const countTicketHeaders = (t: string) => ((t ?? "").match(/\b\d{9}\b/g) ?? []).length;

      // Helper: binary threshold optimized for red digits (Risk column)
      async function preprocessRedForOcr(input: Blob): Promise<Blob> {
        // Binary-threshold image optimized for red digits on light backgrounds.
        // BetMASS Risk digits are red but often anti-aliased (looks orange/pink after scaling/compression).
        // A strict "r - max(g,b)" threshold misses them, so use a ratio + delta test.
        const bmp = await createImageBitmap(input);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return input;

        ctx.drawImage(bmp, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;

        const MIN_R = 90;
        const DELTA = 8;

        for (let i = 0; i < d.length; i += 4) {
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];

          const sum = g + b + 1;
          const ratio = r / sum; // higher when red dominates

          const redish = r >= MIN_R && (r - g) >= DELTA && (r - b) >= DELTA;
          const redishSoft = ratio >= 0.75 && r >= MIN_R; // catches orange/pink edges

          const isText = redish || redishSoft;

          // Output: black text on white background
          const y = isText ? 0 : 255;
          d[i] = y;
          d[i + 1] = y;
          d[i + 2] = y;
        }

        ctx.putImageData(img, 0, 0);

        const outBlob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png")
        );
        return outBlob ?? input;
      }

      // Grayscale + Otsu threshold -> pure B/W. Optionally invert.
      async function preprocessOtsuBW(input: Blob, invert = false): Promise<Blob> {
        // Grayscale + Otsu threshold -> pure B/W. Optionally invert.
        const bmp = await createImageBitmap(input);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return input;

        ctx.drawImage(bmp, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;

        // Build histogram
        const hist = new Array<number>(256).fill(0);
        const gray = new Uint8Array(canvas.width * canvas.height);
        let gi = 0;
        for (let i = 0; i < d.length; i += 4) {
          // Rec. 601 luma
          const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          gray[gi++] = y;
          hist[y] += 1;
        }

        const total = gray.length;
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * hist[t];

        let sumB = 0;
        let wB = 0;
        let wF = 0;
        let varMax = 0;
        let threshold = 128;

        for (let t = 0; t < 256; t++) {
          wB += hist[t];
          if (wB === 0) continue;
          wF = total - wB;
          if (wF === 0) break;

          sumB += t * hist[t];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const varBetween = wB * wF * (mB - mF) * (mB - mF);
          if (varBetween > varMax) {
            varMax = varBetween;
            threshold = t;
          }
        }

        // Apply threshold
        gi = 0;
        for (let i = 0; i < d.length; i += 4) {
          const y = gray[gi++];
          let out = y > threshold ? 255 : 0;
          if (invert) out = 255 - out;
          d[i] = out;
          d[i + 1] = out;
          d[i + 2] = out;
        }

        ctx.putImageData(img, 0, 0);

        const outBlob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png")
        );
        return outBlob ?? input;
      }
      const findWordX = (words: TsvWord[], re: RegExp): { left: number; right: number } | null => {
        const hit = words
          .filter((w) => re.test(w.text))
          .sort((a, b) => a.top - b.top || a.left - b.left)[0];
        if (!hit) return null;
        return { left: hit.left, right: hit.left + hit.width };
      };

      // Lazy-load OCR only when needed
      const Tesseract = await import("tesseract.js");
      if (!ocrWorkerLoadedRef.current) ocrWorkerLoadedRef.current = true;

      const fullOpts: any = {
        logger: (m: any) => {
          if (m?.status === "recognizing text" && typeof m?.progress === "number") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
        tessedit_create_tsv: "1",
        // Full page: allow letters so we can detect BetMASS headers (Pending/Description/Risk/To Win)
        tessedit_pageseg_mode: "6",
        user_defined_dpi: "300",
      };

      const riskOpts: any = {
        tessedit_create_tsv: "1",
        // Risk column: digits-only OCR
        tessedit_char_whitelist: "0123456789.$",
        tessedit_pageseg_mode: "11",
        user_defined_dpi: "300",
      };

      // Full image OCR (raw)
      const resultFull = await (Tesseract as any).recognize(blob, "eng", fullOpts);
      const rawTextFull = resultFull?.data?.text ?? "";
      const tsvFull = (resultFull as any)?.data?.tsv ?? "";

      let text = (visionOk && visionText ? visionText : rawTextFull);
      // If Vision had no consolidated text, keep Tesseract text but still persist Vision annotations.
      // The parser can use annotations to recover Risk/To Win even when text misses red digits.

      // If it looks like BetMASS Pending, attempt a Risk-column crop OCR and merge TSV words.
      const betmassLike = looksLikeBetmassPending(text) || looksLikeBetmassPending(rawTextFull);
      const moneySparse = countMoney(text) < 2;

      if (betmassLike && moneySparse && tsvFull) {
        const wordsFullForBounds = parseTsvWords(tsvFull, 0, 0, 1);
        const riskHdr = findWordX(wordsFullForBounds, /^Risk$/i);
        const winHdr = findWordX(wordsFullForBounds, /^Win$/i);

        // Compute crop bounds in pixels from headers when available.
        // If headers not found, fall back to conservative percentages.
        const bmpForSize = await createImageBitmap(blob);
        const W = bmpForSize.width;

        const fallbackX0 = W * 0.60;
        const fallbackX1 = W * 0.78;

        const baseX0 = riskHdr ? riskHdr.right - 30 : fallbackX0;
        const baseX1 = winHdr ? winHdr.left + 20 : fallbackX1;

        // The Risk amounts in BetMASS are often slightly offset vs the header.
        // Try multiple nearby crops and keep the one that yields the most numeric tokens.
        const candidates: Array<{ x0: number; x1: number; label: string }> = [];

        // Wider band around the expected Risk column
        candidates.push({ x0: baseX0 - 80, x1: baseX1 - 10, label: "wide-left" });
        candidates.push({ x0: baseX0 - 40, x1: baseX1 - 10, label: "wide" });
        candidates.push({ x0: baseX0 - 20, x1: baseX1 - 10, label: "tight" });
        candidates.push({ x0: baseX0, x1: baseX1, label: "shift-right" });
        candidates.push({ x0: baseX0 + 20, x1: baseX1 + 20, label: "more-right" });

        // As a last resort, scan a middle band of the page
        candidates.push({ x0: W * 0.52, x1: W * 0.74, label: "fallback-mid" });
        candidates.push({ x0: W * 0.56, x1: W * 0.80, label: "fallback-mid-wide" });

        const clamp = (v: number) => Math.max(0, Math.min(W, v));
        for (const c of candidates) {
          c.x0 = clamp(c.x0);
          c.x1 = clamp(c.x1);
          if (c.x1 - c.x0 < 30) c.x1 = clamp(c.x0 + 30);
        }

        type RiskAttempt = {
          label: string;
          x0: number;
          x1: number;
          bestLabel: string;
          bestScore: number;
          bestRaw: string;
          bestWords: any[];
          debugPassScores: string;
        };

        let bestAttempt: RiskAttempt | null = null;

        for (const c of candidates) {
          const riskCrop = await cropBlobXPx(blob, c.x0, c.x1, 3);
          if (!riskCrop) continue;

          const riskBW_red = await preprocessRedForOcr(riskCrop.blob);
          const riskBW_otsu = await preprocessOtsuBW(riskCrop.blob, false);
          const riskBW_otsuInv = await preprocessOtsuBW(riskCrop.blob, true);

          const runRisk = async (label: string, b: Blob) => {
            const res = await (Tesseract as any).recognize(b, "eng", {
              ...riskOpts,
              tessedit_pageseg_mode: "6",
              logger: (m: any) => {
                if (m?.status === "recognizing text" && typeof m?.progress === "number") {
                  const pct = Math.round(m.progress * 100);
                  setOcrProgress(Math.max(50, pct));
                }
              },
            });
            const tsv = (res as any)?.data?.tsv ?? "";
            const raw = res?.data?.text ?? "";
            const words = tsv ? parseTsvWords(tsv, riskCrop.offsetLeft, 0, riskCrop.scale) : [];
            const nums = words.filter((w: any) => isNumericToken(w.text));
            return { label, raw, words, nums, score: nums.length };
          };

          const r1 = await runRisk("red-mask", riskBW_red);
          const r2 = await runRisk("otsu", riskBW_otsu);
          const r3 = await runRisk("otsu-invert", riskBW_otsuInv);
          const best = [r1, r2, r3].sort((a, b) => b.score - a.score)[0];

          const attempt: RiskAttempt = {
            label: c.label,
            x0: c.x0,
            x1: c.x1,
            bestLabel: best.label,
            bestScore: best.score,
            bestRaw: best.raw,
            bestWords: best.words,
            debugPassScores: `red-mask=${r1.score} otsu=${r2.score} otsu-invert=${r3.score}`,
          };

          if (!bestAttempt || attempt.bestScore > bestAttempt.bestScore) {
            bestAttempt = attempt;
          }

          // Early exit: if we got a decent number of numeric hits, stop scanning.
          if (attempt.bestScore >= 6) break;
        }

        if (bestAttempt) {
          const wordsFull = wordsFullForBounds;
          const wordsRisk = bestAttempt.bestWords ?? [];

          const merged = wordsFull.concat(wordsRisk);
          const rebuilt = rebuildBetmassPendingTextFromWords(merged);

          const countMoney = (s: string) => ((s.match(/\$\s*\d/g) ?? []).length);
          if (rebuilt && countMoney(rebuilt) > countMoney(rawTextFull)) {
            text = rebuilt;
          } else {
            text = rawTextFull;
          }
        }
      }

      // Keep reference for payload confidence
      const result = resultFull;

      setOcrText(text);

      // Save OCR output to bet_slips.raw_ocr
      const payload = {
        text,
        confidence: result?.data?.confidence ?? null,
        ts: new Date().toISOString(),
        engine: visionOk ? "google-vision+tesseract" : "tesseract.js",
        annotations: visionOk ? visionAnnotations : [],
        textAnnotations: visionOk ? visionAnnotations : [],
        mode: visionOk ? (visionMode ?? "DOCUMENT_TEXT_DETECTION") : undefined,
      };

      const { error: updErr } = await supabase
        .from("bet_slips")
        .update({ raw_ocr: payload })
        .eq("id", slip.id);

      if (updErr) throw updErr;

      setSlip((prev) => (prev ? { ...prev, raw_ocr: payload } : prev));

      setConfirmMsg("OCR saved. Next: Parse to Draft.");
    } catch (e: any) {
      console.error("[ReviewSlip] OCR failed", e);
      setError(e?.message ?? "OCR failed.");
    } finally {
      setOcrRunning(false);
    }
  }

  if (loading) {
    return (
      <section className="px-4 py-8 max-w-3xl mx-auto font-sans">
        <h1 className="font-display text-2xl tracking-[0.18em] uppercase text-yellow-400 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Review Slip
        </h1>
        <p className="text-sm text-slate-400 mt-2">Loading…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="px-4 py-8 max-w-3xl mx-auto font-sans">
        <h1 className="font-display text-2xl tracking-[0.18em] uppercase text-yellow-400 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Review Slip
        </h1>
        <p className="text-sm text-red-300 mt-2">{error}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/80 text-slate-100 hover:text-white"
          >
            Back
          </button>
          <Link
            to="/bets/upload"
            className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/80 text-slate-100 hover:text-white"
          >
            Upload another
          </Link>
        </div>
      </section>
    );
  }

  if (!slip) {
    return (
      <section className="px-4 py-8 max-w-3xl mx-auto font-sans">
        <h1 className="font-display text-2xl tracking-[0.18em] uppercase text-yellow-400 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
          Review Slip
        </h1>
        <p className="text-sm text-slate-400 mt-2">Slip not found.</p>
        <div className="mt-4">
          <Link
            to="/bets/upload"
            className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/80 text-slate-100 hover:text-white"
          >
            Upload a slip
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 py-8 max-w-3xl mx-auto font-sans">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl tracking-[0.18em] uppercase text-yellow-400 drop-shadow-[0_0_12px_rgba(250,204,21,0.35)]">
            Review Slip
          </h1>
          <p className="text-xs text-slate-400 mt-1">Slip ID: {slip.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRunOcr}
            disabled={ocrRunning || deleting || confirming}
            className="px-3 py-1.5 rounded-lg bg-indigo-900/40 border border-indigo-500/60 text-indigo-100 hover:text-indigo-50 text-sm disabled:opacity-40"
          >
            {ocrRunning ? `OCR… ${ocrProgress}%` : "Run OCR"}
          </button>
          <button
            type="button"
            onClick={handleParseToDraft}
            disabled={ocrRunning || deleting || confirming || !(ocrText ?? "").trim()}
            className="px-3 py-1.5 rounded-lg bg-cyan-900/40 border border-cyan-500/60 text-cyan-100 hover:text-cyan-50 text-sm disabled:opacity-40"
          >
            Parse to Draft
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming || deleting}
            className="px-3 py-1.5 rounded-lg bg-emerald-900/40 border border-emerald-500/60 text-emerald-100 hover:text-emerald-50 text-sm disabled:opacity-40"
          >
            {confirming ? "Confirming…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || confirming}
            className="px-3 py-1.5 rounded-lg bg-rose-900/40 border border-rose-500/60 text-rose-100 hover:text-rose-50 text-sm disabled:opacity-40"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <Link
            to="/bets/upload"
            className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-slate-700/80 text-slate-100 hover:text-white text-sm"
          >
            Upload another
          </Link>
        </div>
      </header>

      <div className="mt-5 rounded-2xl bg-slate-900/70 border border-slate-700/70 p-4">
        <div className="text-sm text-slate-200">
          <div>
            <span className="text-slate-400">Status:</span>{" "}
            <span className="font-mono text-slate-100">{slip.status ?? "—"}</span>
          </div>
          <div className="mt-2">
            <span className="text-slate-400">Image path:</span>{" "}
            <span className="font-mono text-slate-100 break-all">{slip.image_path ?? "—"}</span>
          </div>
        </div>

        {imageUrl && (
          <div className="mt-4 rounded-xl border border-slate-800 overflow-hidden bg-black/30">
            <img
              src={imageUrl}
              alt="Uploaded bet slip"
              className="w-full object-contain max-h-[520px]"
            />
          </div>
        )}

        {(ocrText || ocrRunning) && (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">OCR Text</div>
            <div className="mt-2 text-[11px] text-slate-400">
              {ocrRunning ? "Running OCR…" : "Saved to bet_slips.raw_ocr"}
            </div>
            <pre className="mt-2 text-[12px] leading-snug text-slate-200 bg-slate-950/60 border border-slate-800 rounded-xl p-3 overflow-auto max-h-[220px]">
              {ocrText || "(no text extracted)"}
            </pre>
          </div>
        )}

        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Odds Lookup (Event Props)</div>
          <div className="mt-2 text-[11px] text-slate-400">
            Paste an Odds API <span className="font-mono">eventId</span> and fetch player props from your backend.
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">sportKey</label>
              <input
                type="text"
                value={oddsSportKey}
                onChange={(e) => setOddsSportKey(e.target.value)}
                placeholder="basketball_nba"
                className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">regions</label>
              <input
                type="text"
                value={oddsRegions}
                onChange={(e) => setOddsRegions(e.target.value)}
                placeholder="us"
                className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] text-slate-500 mb-1">eventId</label>
              <input
                type="text"
                value={oddsEventId}
                onChange={(e) => setOddsEventId(e.target.value)}
                placeholder="c8523141aaa4ff1f5221721713a92dca"
                className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">markets</label>
              <input
                type="text"
                value={oddsMarkets}
                onChange={(e) => setOddsMarkets(e.target.value)}
                placeholder="auto"
                className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleFetchEventProps}
                disabled={oddsLoading || deleting || confirming}
                className="w-full px-3 py-2 rounded-lg bg-slate-900/80 border border-slate-700/80 text-slate-100 hover:text-white text-sm disabled:opacity-40"
              >
                {oddsLoading ? "Fetching…" : "Fetch props"}
              </button>
            </div>
          </div>

          {oddsError ? (
            <div className="mt-3 text-sm text-rose-200 border border-rose-500/30 bg-rose-900/20 rounded-xl p-3">
              {oddsError}
            </div>
          ) : null}

          {oddsResp ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] text-slate-500">Show fetched props</summary>
              {normalizedProps.length ? (
                <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40 overflow-auto max-h-[320px]">
                  <table className="w-full text-[12px]">
                    <thead className="sticky top-0 bg-slate-950/95 border-b border-slate-800">
                      <tr className="text-left text-slate-400">
                        <th className="p-2">Player</th>
                        <th className="p-2">Market</th>
                        <th className="p-2">Side</th>
                        <th className="p-2">Line</th>
                        <th className="p-2">Price</th>
                        <th className="p-2">Book</th>
                      </tr>
                    </thead>
                    <tbody>
                      {normalizedProps.map((r, i) => (
                        <tr key={i} className="border-b border-slate-900/60 text-slate-200">
                          <td className="p-2 whitespace-nowrap">{r.player || "—"}</td>
                          <td className="p-2 whitespace-nowrap font-mono text-slate-300">{r.market}</td>
                          <td className="p-2 whitespace-nowrap">{r.side}</td>
                          <td className="p-2 whitespace-nowrap">{r.line ?? "—"}</td>
                          <td className="p-2 whitespace-nowrap">{r.price ?? "—"}</td>
                          <td className="p-2 whitespace-nowrap">{r.book}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-2 text-sm text-slate-400">No prop outcomes returned for this event.</div>
              )}

              <pre className="mt-3 text-[12px] leading-snug text-slate-200 bg-slate-950/60 border border-slate-800 rounded-xl p-3 overflow-auto max-h-[240px]">
                {JSON.stringify(oddsResp, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Parsed (review & edit)</div>

          {confirmMsg && (
            <div className="mt-2 text-sm text-emerald-200 border border-emerald-500/30 bg-emerald-900/20 rounded-xl p-3">
              {confirmMsg}
            </div>
          )}

          {!betsDraft.length ? (
            <div className="mt-2 text-sm text-slate-400">
              No parsed bets yet. Run OCR, then click “Parse to Draft.”
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {betsDraft.map((b, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="text-sm text-slate-200">
                      <span className="text-slate-500">Bet</span> #{idx + 1}
                      {b.issues?.length ? (
                        <span className="ml-2 text-[11px] text-amber-300">
                          {b.issues.length} issue{b.issues.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      conf {Math.round((b.confidence ?? 0) * 100)}%
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 font-mono">
                    market_key: {b.market_key ?? "—"}
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`market-${idx}`} className="block text-[11px] text-slate-500 mb-1">Market</label>
                      <select
                        id={`market-${idx}`}
                        aria-label={`Market for bet ${idx + 1}`}
                        value={b.market_type}
                        onChange={(e) => {
                          const v = e.target.value as MarketType;
                      const inferMarketKey = (mt: MarketType, selectionText: string): string | null => {
                        const s = String(mt);
                        if (s.includes("moneyline")) return "h2h";
                        if (s.includes("spread")) return "spreads";
                        if (s.includes("total")) return "totals";
                        // Props: try to infer a specific key for player props
                        if (s.includes("player_prop")) return inferPropMarketKeyFromSelection(selectionText) ?? "player_props";
                        if (s.includes("game_prop")) return "game_props";
                        return null;
                      };

                      setBetsDraft((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, market_type: v, market_key: inferMarketKey(v, x.selection_text ?? "") } : x
                        )
                      );
                        }}
                        className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
                      >
                        {MARKET_TYPE_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label htmlFor={`odds-${idx}`} className="block text-[11px] text-slate-500 mb-1">
                        Odds (American)
                        {b.stake != null && b.to_win != null && (b.issues ?? []).includes("missing_odds") ? (
                          <span className="ml-1 text-[10px] text-slate-600">(inferred)</span>
                        ) : null}
                      </label>
                      <input
                        id={`odds-${idx}`}
                        aria-label={`Odds for bet ${idx + 1}`}
                        type="number"
                        value={b.odds_american ?? ""}
                        onChange={(e) => {
                          const n = safeNumber(e.target.value);
                          setBetsDraft((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, odds_american: n } : x))
                          );
                        }}
                        placeholder="-110"
                        className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label htmlFor={`selection-${idx}`} className="block text-[11px] text-slate-500 mb-1">Selection</label>
                      <input
                        id={`selection-${idx}`}
                        aria-label={`Selection for bet ${idx + 1}`}
                        type="text"
                        value={b.selection_text}
                        onChange={(e) => {
                          const v = e.target.value;
                          setBetsDraft((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, selection_text: v } : x))
                          );
                        }}
                        placeholder="Christian McCaffrey Over 40.5 Rec Yds"
                        className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
                      />
                    </div>

                    <div>
                      <label htmlFor={`stake-${idx}`} className="block text-[11px] text-slate-500 mb-1">Stake</label>
                      <input
                        id={`stake-${idx}`}
                        aria-label={`Stake for bet ${idx + 1}`}
                        type="number"
                        step="0.01"
                        value={b.stake ?? ""}
                        onChange={(e) => {
                          const n = safeNumber(e.target.value);
                          setBetsDraft((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, stake: n } : x))
                          );
                        }}
                        placeholder="50"
                        className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
                      />
                    </div>

                    <div>
                      <label htmlFor={`towin-${idx}`} className="block text-[11px] text-slate-500 mb-1">To Win</label>
                      <input
                        id={`towin-${idx}`}
                        aria-label={`To win for bet ${idx + 1}`}
                        type="number"
                        step="0.01"
                        value={b.to_win ?? ""}
                        onChange={(e) => {
                          const n = safeNumber(e.target.value);
                          setBetsDraft((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, to_win: n } : x))
                          );
                        }}
                        placeholder="118.50"
                        className="w-full rounded-lg bg-slate-900/80 border border-slate-700/80 px-3 py-2 text-sm text-slate-100"
                      />
                    </div>
                  </div>

                  {b.event || b.league || b.event_date ? (
                    <div className="mt-3 text-[11px] text-slate-500">
                      {b.league ? <span className="mr-2">{b.league}</span> : null}
                      {b.event ? <span className="mr-2">· {b.event}</span> : null}
                      {b.event_date ? <span>· {new Date(b.event_date).toLocaleString()}</span> : null}
                    </div>
                  ) : null}

                  {b.issues?.length ? (
                    <ul className="mt-2 text-[11px] text-amber-200 list-disc pl-5">
                      {b.issues.map((iss, j) => (
                        <li key={j}>{iss}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={confirming || deleting}
                  className="px-4 py-2 rounded-xl bg-emerald-900/40 border border-emerald-500/60 text-emerald-100 hover:text-emerald-50 text-sm disabled:opacity-40"
                >
                  {confirming ? "Confirming…" : `Confirm ${betsDraft.length} bet(s)`}
                </button>
              </div>

              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-slate-500">Show raw JSON</summary>
                <pre className="mt-2 text-[12px] leading-snug text-slate-200 bg-slate-950/60 border border-slate-800 rounded-xl p-3 overflow-auto">
                  {JSON.stringify(parsed, null, 2)}
                </pre>
              </details>
            </div>
          )}

          <p className="text-[11px] text-slate-500 mt-3">
            Confirm inserts one row per bet into <span className="font-mono">public.bets</span> (status: pending). OCR/AI parsing comes next.
          </p>
        </div>
      </div>
    </section>
  );
}