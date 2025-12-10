// src/lib/MoneylineMastery.ts
// Helpers for computing "Moneyline Mastery" scores based on a user's moneyline picks.
//
// Design goals:
// - Reward underdog wins by the exact price the user captured (e.g. +135 -> +135 points).
// - Penalize favorite losses by the exact price risked (e.g. -360 -> -360 points).
// - Keep things intuitive and directly proportional to the American moneyline.
// - Use a simple, symmetric rule set so it's easy to explain to users.
//
// Scoring (per pick):
// - outcome: "win" | "loss" | "push" | "pending"
// - odds: American odds at the time of the pick (e.g. -150, +135)
//
// 1) Push or pending:
//    -> 0 (no change)
//
// 2) Underdogs (odds >= 0):
//    - Win:  +odds         (win at +135 -> +135)
//    - Loss: -100          (standard 1 unit loss)
//
// 3) Favorites (odds < 0):
//    - Win:  +100          (standard 1 unit win)
//    - Loss: -abs(odds)    (loss at -360 -> -360)
//
// This creates a landscape where:
// - Chasing big favorites is dangerous (losses are brutal).
// - Hunting dogs is rewarding when you're right.
// - Everything is directly tied to the line you locked in.

export type MoneylineOutcome = "win" | "loss" | "push" | "pending";

/**
 * Compute the Moneyline Mastery delta for a single pick.
 *
 * @param odds - American moneyline odds at the time of the pick (e.g. -150, +135)
 * @param outcome - graded result for this pick
 * @returns numeric delta to add to the user's Moneyline Mastery score
 */
export function moneylineMasteryDelta(
  odds: number | null | undefined,
  outcome: MoneylineOutcome
): number {
  if (odds == null || Number.isNaN(odds)) return 0;
  if (outcome === "push" || outcome === "pending") return 0;

  const o = Number(odds);

  // Underdogs: odds >= 0
  if (o >= 0) {
    if (outcome === "win") {
      // Reward equals the underdog price you captured (e.g. +135 -> +135)
      return o;
    }
    // Losing dog: standard 1u loss
    return -100;
  }

  // Favorites: odds < 0
  const risk = Math.abs(o);
  if (outcome === "win") {
    // Winning favorite: standard +1u
    return +100;
  }

  // Losing favorite: punished by the true risk (e.g. -360 -> -360)
  return -risk;
}

/**
 * Convenience helper to aggregate Moneyline Mastery over a list of picks.
 * Expects each pick to have `picked_price_type`, `picked_price`, and a `grade`
 * field that is compatible with MoneylineOutcome.
 */
export function sumMoneylineMastery<T extends { picked_price_type?: string | null; picked_price?: number | null; grade: MoneylineOutcome }>(
  picks: T[]
): number {
  return picks.reduce((total, p) => {
    if (p.picked_price_type !== "ml") return total;
    return total + moneylineMasteryDelta(p.picked_price ?? null, p.grade);
  }, 0);
}
