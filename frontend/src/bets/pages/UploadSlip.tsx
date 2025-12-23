import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { ensureSession } from "../../lib/session";

const BUCKET = "bet-slips";

function extFromFile(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".png")) return "png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpg";
  if (name.endsWith(".webp")) return "webp";
  return "png";
}

export default function UploadSlip() {
  const nav = useNavigate();

  const [uid, setUid] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!mounted) return;
      setUid(session?.user?.id ?? null);
    });

    (async () => {
      try {
        setSessionLoading(true);
        setSessionError(null);
        const id = await ensureSession();
        if (!mounted) return;

        if (!id) {
          setUid(null);
          setSessionError("Could not create or restore a session. Try refreshing.");
        } else {
          setUid(id);
        }
      } catch (e: any) {
        if (!mounted) return;
        setUid(null);
        setSessionError(e?.message ?? "Failed to initialize session.");
      } finally {
        if (!mounted) return;
        setSessionLoading(false);
      }
    })();

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!file) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const canUpload = useMemo(() => !!uid && !!file && !uploading, [uid, file, uploading]);

  async function handleUpload() {
    if (!uid || !file) return;

    setUploading(true);
    setError(null);

    const ext = extFromFile(file);
    const slipId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const imagePath = `${uid}/${slipId}.${ext}`;

    try {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(imagePath, file, {
        upsert: true,
        contentType: file.type || (ext === "jpg" ? "image/jpeg" : `image/${ext}`),
      });

      if (upErr) throw upErr;

      const { data: slipRow, error: slipErr } = await supabase
        .from("bet_slips")
        .insert({
          id: slipId,
          user_id: uid,
          status: "uploaded",
          image_path: imagePath,
        } as any)
        .select("id")
        .single();

      if (slipErr) {
        const { data: slipRow2, error: slipErr2 } = await supabase
          .from("bet_slips")
          .insert({
            user_id: uid,
            status: "uploaded",
            image_path: imagePath,
          } as any)
          .select("id")
          .single();

        if (slipErr2) throw slipErr2;
        if (!slipRow2?.id) throw new Error("bet_slips insert did not return an id.");

        nav(`/bets/review/${slipRow2.id}`);
        return;
      }

      if (!slipRow?.id) throw new Error("bet_slips insert did not return an id.");

      nav(`/bets/review/${slipRow.id}`);
    } catch (e: any) {
      console.error("[UploadSlip] upload failed", e);

      try {
        await supabase.storage.from(BUCKET).remove([imagePath]);
      } catch {
        // ignore cleanup errors
      }

      setError(e?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  if (sessionLoading) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">Upload bet slip</h1>
        <p className="text-sm text-slate-400 mt-2">Initializing session…</p>
      </div>
    );
  }

  if (!uid) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">Upload bet slip</h1>
        <p className="text-sm text-rose-300 mt-2">{sessionError ?? "No session."}</p>
        <p className="text-sm text-slate-400 mt-2">Try refreshing. If it persists, log out/in.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6 text-slate-100">
      <header className="mb-4">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">Upload bet slip</h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1">
          Upload a screenshot/photo. You’ll review + confirm before anything is saved as a bet.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
        <div className="flex flex-col gap-3">
          <label htmlFor="bet-slip-file" className="text-sm font-semibold text-slate-200">
            Slip image
          </label>
          <input
            type="file"
            id="bet-slip-file"
            aria-label="Upload bet slip image"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-slate-300
              file:mr-4 file:rounded-full file:border-0
              file:bg-slate-800 file:px-4 file:py-2 file:text-sm file:font-semibold
              file:text-slate-100 hover:file:bg-slate-700"
            disabled={uploading}
          />

          {previewUrl && (
            <div className="rounded-xl border border-slate-800 overflow-hidden bg-black/30">
              <img src={previewUrl} alt="Slip preview" className="w-full object-contain max-h-[520px]" />
            </div>
          )}

          {error && <div className="text-sm text-rose-300">{error}</div>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleUpload}
              disabled={!canUpload}
              className="px-4 py-2 rounded-full bg-yellow-400 text-slate-900 font-semibold
                disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-95"
            >
              {uploading ? "Uploading…" : "Upload & review"}
            </button>

            <button
              type="button"
              onClick={() => {
                setFile(null);
                setError(null);
              }}
              disabled={uploading}
              className="px-4 py-2 rounded-full bg-slate-900/80 border border-slate-700 text-slate-200
                disabled:opacity-40 hover:text-slate-100"
            >
              Clear
            </button>
          </div>

          <p className="text-[11px] text-slate-500">Tip: Cropping tight around the slip improves OCR accuracy.</p>
        </div>
      </div>
    </div>
  );
}