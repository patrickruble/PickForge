import { useEffect, useState } from "react";

/** Re-renders the component every `intervalMs` (default 30s) and returns Date.now(). */
export default function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}