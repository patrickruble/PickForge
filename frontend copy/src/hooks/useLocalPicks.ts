import { useEffect, useState } from "react";

export type Side = "home" | "away";
export type PickValue = { side: Side; timestamp: string };
export type Picks = Record<string, PickValue | undefined>;

const KEY = "pickforge:picks:v1";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

export function useLocalPicks() {
  const [picks, setPicks] = useState<Picks>({});

  // boot from localStorage (migrate old string-only values if found)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return;

      const nowIso = new Date().toISOString();
      const migrated: Picks = {};
      for (const [gameId, v] of Object.entries(parsed)) {
        if (typeof v === "string" && (v === "home" || v === "away")) {
          migrated[gameId] = { side: v, timestamp: nowIso };
        } else if (
          isRecord(v) &&
          (v.side === "home" || v.side === "away") &&
          typeof v.timestamp === "string"
        ) {
          migrated[gameId] = { side: v.side as Side, timestamp: v.timestamp };
        }
      }
      setPicks(migrated);
    } catch {
      // ignore
    }
  }, []);

  // persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(picks));
    } catch {
      // ignore
    }
  }, [picks]);

  /** True if a game starting at `commenceTime` is locked. */
  const isLocked = (commenceTime: string, nowMs: number = Date.now()) =>
    nowMs >= new Date(commenceTime).getTime();

  /** Toggle a pick; prevents changes after kickoff. */
  const togglePick = (gameId: string, side: Side, commenceTime: string) => {
    if (isLocked(commenceTime)) {
      // soft UX: inform but don’t throw
      alert("Too late! This game has already started.");
      return;
    }
    setPicks((p) => {
      const current = p[gameId];
      // clicking the same side again un-picks it
      const next =
        current?.side === side ? undefined : { side, timestamp: new Date().toISOString() };
      return { ...p, [gameId]: next };
    });
  };

  const clear = () => setPicks({});

  return { picks, togglePick, clear, isLocked };
}