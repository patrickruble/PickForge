import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";

type BetSlipRow = {
  id: string;
  user_id: string;
  status: string | null;
  image_path: string | null;
  parsed: any | null;
  raw_ocr: any | null;
};

export default function ReviewSlip() {
  const { slipId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slip, setSlip] = useState<BetSlipRow | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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

      const row = (data as BetSlipRow) ?? null;
      setSlip(row);

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
            onClick={handleDelete}
            disabled={deleting}
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

        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">Parsed (draft)</div>
          <pre className="mt-2 text-[12px] leading-snug text-slate-200 bg-slate-950/60 border border-slate-800 rounded-xl p-3 overflow-auto">
            {JSON.stringify(slip.parsed ?? {}, null, 2)}
          </pre>

          <p className="text-[11px] text-slate-500 mt-3">
            Next step: render editable bet rows here (one per leg), allow user corrections, then on Confirm insert rows into <span className="font-mono">public.bets</span>.
          </p>
        </div>
      </div>
    </section>
  );
}