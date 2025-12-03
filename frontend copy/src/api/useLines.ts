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

// Use env var if set (strip trailing slash), otherwise localhost
const API_BASE =
  (import.meta as any).env?.VITE_API_URL?.replace(/\/$/, "") ||
  "http://localhost:8787";

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
    // expose backend meta (rate-limit headers + timestamp)
    meta: data?.meta,
    error,
    isLoading: !!isLoading,
    isValidating: !!isValidating,
    refresh: () => mutate(),
  };
}