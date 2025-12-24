import { useEffect, useMemo, useRef, useState } from "react";
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

      const nextParsed = parseSlipFromOcr(text);

      if (!nextParsed.meta) {
        nextParsed.meta = { parser_version: "dev", source: "ocr" };
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

  useEffect(() => {
    // Initialize editable rows when slip/parsed changes
    const baseWager = safeNumber(parsed.wager);
    const baseToWin = safeNumber(parsed.to_win);
    const legs = parsed.bets?.length ?? 0;

    const perLegStake =
      baseWager != null && legs > 0 ? Math.round((baseWager / legs) * 100) / 100 : null;
    const perLegToWin =
      baseToWin != null && legs > 0 ? Math.round((baseToWin / legs) * 100) / 100 : null;

    const rows: EditableBet[] = (parsed.bets ?? []).map((b) => ({
      market_type: (b.market_type ?? "other") as MarketType,
      selection_text: b.selection_text ?? "",
      odds_american: b.odds_american ?? null,
      sport: b.sport ?? null,
      league: b.league ?? null,
      event: b.event ?? null,
      event_date: b.event_date ?? null,
      side: (b.side ?? null) as SideType,
      line: b.line ?? null,
      confidence: typeof b.confidence === "number" ? b.confidence : 0,
      issues: Array.isArray(b.issues) ? b.issues : [],
      stake: perLegStake,
      to_win: perLegToWin,
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
              sport: (betsDraft[0]?.league ?? betsDraft[0]?.sport ?? "Unknown") as string,
              book_name: book,
              event_name: parsed.ticket_no ? `Parlay ${parsed.ticket_no}` : "Parlay",
              event_date: parsed.placed_at ? new Date(parsed.placed_at).toISOString() : null,
              bet_type: "parlay",
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
              sport: (b.league ?? b.sport ?? "Unknown") as string,
              book_name: book,
              event_name: eventName,
              event_date: b.event_date ? new Date(b.event_date).toISOString() : null,
              bet_type: betType,
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

      // Fetch image as blob
      const resp = await fetch(signedUrl);
      if (!resp.ok) throw new Error(`Failed to download image (${resp.status}).`);
      const blob = await resp.blob();

      // Lazy-load OCR only when needed
      const Tesseract = await import("tesseract.js");
      if (!ocrWorkerLoadedRef.current) ocrWorkerLoadedRef.current = true;

      const result = await Tesseract.recognize(blob, "eng", {
        logger: (m: any) => {
          if (m?.status === "recognizing text" && typeof m?.progress === "number") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });

      const text = result?.data?.text ?? "";
      setOcrText(text);

      // Save OCR output to bet_slips.raw_ocr
      const payload = {
        text,
        confidence: result?.data?.confidence ?? null,
        ts: new Date().toISOString(),
        engine: "tesseract.js",
      };

      const { error: updErr } = await supabase
        .from("bet_slips")
        .update({ raw_ocr: payload })
        .eq("id", slip.id);

      if (updErr) throw updErr;

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

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor={`market-${idx}`} className="block text-[11px] text-slate-500 mb-1">Market</label>
                      <select
                        id={`market-${idx}`}
                        aria-label={`Market for bet ${idx + 1}`}
                        value={b.market_type}
                        onChange={(e) => {
                          const v = e.target.value as MarketType;
                          setBetsDraft((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, market_type: v } : x))
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
                      <label htmlFor={`odds-${idx}`} className="block text-[11px] text-slate-500 mb-1">Odds (American)</label>
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