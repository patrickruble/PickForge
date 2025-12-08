// src/lib/betMath.ts

export function calcToWin(odds: number, stake: number): number {
  if (!stake || !odds) return 0;

  if (odds < 0) {
    // Risk X to win (100 * X / |odds|)
    return +(stake * (100 / Math.abs(odds))).toFixed(2);
  }

  // odds > 0 → risk X to win (X * odds / 100)
  return +(stake * (odds / 100)).toFixed(2);
}

export function calcResultAmount(
  status: "pending" | "won" | "lost" | "push" | "void",
  stake: number,
  toWin: number
): number {
  switch (status) {
    case "won":
      return +toWin.toFixed(2);
    case "lost":
      return +(-stake).toFixed(2);
    case "push":
    case "void":
    case "pending":
    default:
      return 0;
  }
}