/// <reference types="node" />

import { JWT } from "google-auth-library";

type SA = {
  client_email: string;
  private_key: string;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseServiceAccount(): SA {
  const raw = mustEnv("GOOGLE_VISION_SERVICE_ACCOUNT");
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_VISION_SERVICE_ACCOUNT is not valid JSON");
  }
  if (!obj.client_email || !obj.private_key) {
    throw new Error("Service account JSON missing client_email/private_key");
  }
  return { client_email: obj.client_email, private_key: obj.private_key };
}

async function fetchAsBase64(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // guardrail: ~8MB-ish base64 payload safety
  if (buf.length > 7.5 * 1024 * 1024) throw new Error("Image too large for OCR");
  return buf.toString("base64");
}

function normalizeBody(req: any): any {
  // Vercel dev can sometimes hand you a string body depending on setup.
  const b: any = (req as any).body;
  if (!b) return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return b;
}

// --- Vision debug helpers ---
type VisionVertex = { x?: number; y?: number };
type VisionPoly = { vertices?: VisionVertex[] };
type VisionAnn = { description?: string; boundingPoly?: VisionPoly };

function centerOf(poly?: VisionPoly): { x: number; y: number } {
  const v = poly?.vertices ?? [];
  if (!v.length) return { x: 0, y: 0 };
  const xs = v.map((p) => p.x ?? 0);
  const ys = v.map((p) => p.y ?? 0);
  return {
    x: xs.reduce((a, b) => a + b, 0) / xs.length,
    y: ys.reduce((a, b) => a + b, 0) / ys.length,
  };
}

function buildDollarAmounts(annotations: VisionAnn[]): Array<{ value: number; x: number; y: number }> {
  const anns = Array.isArray(annotations) ? annotations.slice(1) : [];
  const dollars = anns
    .filter((a) => (a.description ?? "") === "$")
    .map((a) => ({ a, c: centerOf(a.boundingPoly) }))
    .filter((x) => x.c.x > 0 && x.c.y > 0);

  const nums = anns
    .filter((a) => /^\d{1,5}(?:\.\d{1,2})?$/.test(a.description ?? ""))
    .map((a) => ({ a, c: centerOf(a.boundingPoly) }))
    .filter((x) => x.c.x > 0 && x.c.y > 0);

  const out: Array<{ value: number; x: number; y: number }> = [];

  for (const d of dollars) {
    const cand = nums
      .filter((n) => Math.abs(n.c.y - d.c.y) < 18 && n.c.x > d.c.x && n.c.x - d.c.x < 160)
      .sort((p, q) => (p.c.x - d.c.x) - (q.c.x - d.c.x))[0];

    if (!cand) continue;
    const val = Number(cand.a.description);
    if (!Number.isFinite(val)) continue;
    out.push({ value: val, x: cand.c.x, y: cand.c.y });
  }

  return out;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const body = normalizeBody(req);

    const { imageUrl, imageBase64, mode, debug } = (body ?? {}) as {
      imageUrl?: string;
      imageBase64?: string;
      mode?: "DOCUMENT_TEXT_DETECTION" | "TEXT_DETECTION";
      debug?: boolean;
    };

    const hasUrl = typeof imageUrl === "string" && imageUrl.length > 0;
    const hasB64 = typeof imageBase64 === "string" && imageBase64.length > 0;

    if (!hasUrl && !hasB64) {
      res.status(400).json({ error: "Missing imageUrl or imageBase64" });
      return;
    }

    // Strip any data URL prefix if present.
    const normalizedB64 = hasB64
      ? imageBase64!.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
      : null;

    const sa = parseServiceAccount();

    // Vision scope (classic OCR endpoint). cloud-platform is fine for Vision.
    const jwt = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    const token = await jwt.authorize();
    const accessToken = (token as any).access_token;
    if (!accessToken) throw new Error("Failed to obtain Google access token");

    const content = normalizedB64 ?? (await fetchAsBase64(imageUrl!));

    const featureType = mode ?? "DOCUMENT_TEXT_DETECTION";

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

    const data = await visionResp.json();
    if (!visionResp.ok) {
      res.status(visionResp.status).json({ error: "Vision API error", details: data });
      return;
    }

    const r0 = data?.responses?.[0] ?? {};

    // Google can return fullTextAnnotation OR just textAnnotations[0].description.
    const textFromFull = r0?.fullTextAnnotation?.text;
    const textFromTA0 = Array.isArray(r0?.textAnnotations) ? r0.textAnnotations?.[0]?.description : undefined;
    const text = (textFromFull ?? textFromTA0 ?? "") as string;

    const textAnnotations = r0?.textAnnotations ?? [];

    res.status(200).json({
      mode: featureType,
      text,

      // Keep your existing fields for compatibility
      fullTextAnnotation: r0?.fullTextAnnotation ?? null,
      textAnnotations,

      //  New canonical field name for downstream parsing
      annotations: textAnnotations,

      //  Helpful when we’re debugging “why didn’t it see the red risk numbers?”
      debug: debug
        ? {
            annotationCount: Array.isArray(textAnnotations) ? textAnnotations.length : 0,
            hasFullText: Boolean(r0?.fullTextAnnotation?.text),
            hasTextAnnotations: Array.isArray(textAnnotations) && textAnnotations.length > 0,

            // Compact token centers (first 250) so we can quickly see if Risk digits exist.
            tokens: (Array.isArray(textAnnotations) ? textAnnotations.slice(1, 251) : []).map((a: any) => {
              const c = centerOf(a?.boundingPoly);
              return { t: a?.description ?? "", x: Math.round(c.x), y: Math.round(c.y) };
            }),

            // Parsed $ amounts (pairs '$' + number) with centers.
            amounts: buildDollarAmounts(textAnnotations as any),

            // Heuristic column buckets (based on observed BetMASS layout)
            riskAmounts: buildDollarAmounts(textAnnotations as any).filter((a) => a.x >= 760 && a.x <= 950),
            winAmounts: buildDollarAmounts(textAnnotations as any).filter((a) => a.x >= 980 && a.x <= 1250),
          }
        : undefined,

      error: r0?.error ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: "Server error", details: e?.message ?? String(e) });
  }
}