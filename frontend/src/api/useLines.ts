import useSWR from "swr";
import type { Game } from "../types";

// Backend response shape (matches backend: meta.{xRemaining,xUsed,fetchedAt})
interface LinesResponse {
  league: string;
  games: Game[];
  meta?: {
    xRemaining?: string | null;
    xUsed?: string | null;
    fetchedAt?: string;
  };
}

/**
 * Decide which backend base URL to hit.
 *
 * Priority:
 * 1. VITE_LINES_URL  (explicit backend URL for lines)
 * 2. VITE_API_URL    (general API URL – what you have in .env.local)
 * 3. Fallback: Render backend https://pickforge.onrender.com
 */
const rawBase =
  (import.meta as any).env?.VITE_LINES_URL ??
  (import.meta as any).env?.VITE_API_URL ??
  "https://pickforge.onrender.com";

const API_BASE: string = rawBase.replace(/\/$/, ""); // strip trailing slash just in case

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    throw new Error(
      `Request failed ${res.status} ${res.statusText} → ${JSON.stringify(detail)}`
    );
  }
  return res.json() as Promise<T>;
}

export function useLines(league: "nfl" | "ncaaf" = "nfl") {
  const params = new URLSearchParams({
    league,
    markets: "spreads,moneyline",
  });

  const key = `${API_BASE}/api/lines?${params.toString()}`;

  const { data, error, isLoading, isValidating, mutate } = useSWR<LinesResponse>(
    key,
    fetcher<LinesResponse>,
    {
      refreshInterval: 60_000,
      dedupingInterval: 10_000,
      revalidateOnFocus: false,
      shouldRetryOnError: true,
      errorRetryCount: 3,
      errorRetryInterval: 3000,
    }
  );

  return {
    games: data?.games ?? [],
    league: data?.league ?? league,
    meta: data?.meta,
    error,
    isLoading: !!isLoading,
    isValidating: !!isValidating,
    refresh: () => mutate(),
  };
}