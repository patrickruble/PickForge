// src/data/logos.ts

/**
 * Returns the hosted ESPN logo URL for an NFL team abbreviation.
 * Example: BAL → https://a.espncdn.com/i/teamlogos/nfl/500/BAL.png
 */
// src/data/logos.ts
export function logoUrlForAbbr(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toUpperCase()}.png`;
}