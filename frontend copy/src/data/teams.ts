// src/data/teams.ts
export type TeamKey = string;

export interface TeamMeta {
  name: string;
  abbr: string;
  primary: string;   // banner background
  secondary: string; // text/icon accent
}

const T = (name: string, abbr: string, primary: string, secondary: string): TeamMeta =>
  ({ name, abbr, primary, secondary });

// Quick color set (close enough to official brand colors)
export const TEAM_META: Record<TeamKey, TeamMeta> = {
  "Arizona Cardinals":              T("Arizona Cardinals", "ARI", "#97233F", "#FFB612"),
  "Atlanta Falcons":                T("Atlanta Falcons", "ATL", "#A71930", "#000000"),
  "Baltimore Ravens":               T("Baltimore Ravens", "BAL", "#241773", "#9E7C0C"),
  "Buffalo Bills":                  T("Buffalo Bills", "BUF", "#00338D", "#C60C30"),
  "Carolina Panthers":              T("Carolina Panthers", "CAR", "#0085CA", "#101820"),
  "Chicago Bears":                  T("Chicago Bears", "CHI", "#0B162A", "#C83803"),
  "Cincinnati Bengals":             T("Cincinnati Bengals", "CIN", "#FB4F14", "#000000"),
  "Cleveland Browns":               T("Cleveland Browns", "CLE", "#311D00", "#FF3C00"),
  "Dallas Cowboys":                 T("Dallas Cowboys", "DAL", "#041E42", "#869397"),
  "Denver Broncos":                 T("Denver Broncos", "DEN", "#002244", "#FB4F14"),
  "Detroit Lions":                  T("Detroit Lions", "DET", "#0076B6", "#B0B7BC"),
  "Green Bay Packers":              T("Green Bay Packers", "GB",  "#203731", "#FFB612"),
  "Houston Texans":                 T("Houston Texans", "HOU", "#03202F", "#A71930"),
  "Indianapolis Colts":             T("Indianapolis Colts", "IND", "#002C5F", "#A5ACAF"),
  "Jacksonville Jaguars":           T("Jacksonville Jaguars", "JAX", "#006778", "#D7A22A"),
  "Kansas City Chiefs":             T("Kansas City Chiefs", "KC",  "#E31837", "#FFB81C"),
  "Las Vegas Raiders":              T("Las Vegas Raiders", "LV",  "#000000", "#A5ACAF"),
  "Los Angeles Chargers":           T("Los Angeles Chargers", "LAC", "#0080C6", "#FFC20E"),
  "Los Angeles Rams":               T("Los Angeles Rams", "LAR", "#003594", "#FFA300"),
  "Miami Dolphins":                 T("Miami Dolphins", "MIA", "#008E97", "#F26A24"),
  "Minnesota Vikings":              T("Minnesota Vikings", "MIN", "#4F2683", "#FFC62F"),
  "New England Patriots":           T("New England Patriots", "NE",  "#002244", "#C60C30"),
  "New Orleans Saints":             T("New Orleans Saints", "NO",  "#D3BC8D", "#101820"),
  "New York Giants":                T("New York Giants", "NYG", "#0B2265", "#A71930"),
  "New York Jets":                  T("New York Jets", "NYJ", "#125740", "#FFFFFF"),
  "Philadelphia Eagles":            T("Philadelphia Eagles", "PHI","#004C54", "#A5ACAF"),
  "Pittsburgh Steelers":            T("Pittsburgh Steelers", "PIT","#FFB612", "#101820"),
  "San Francisco 49ers":            T("San Francisco 49ers", "SF", "#AA0000", "#B3995D"),
  "Seattle Seahawks":               T("Seattle Seahawks", "SEA","#002244", "#69BE28"),
  "Tampa Bay Buccaneers":           T("Tampa Bay Buccaneers", "TB","#D50A0A", "#34302B"),
  "Tennessee Titans":               T("Tennessee Titans", "TEN","#0C2340", "#4B92DB"),
  "Washington Commanders":          T("Washington Commanders", "WAS", "#5A1414", "#FFB612"),
};

// Normalize: handle small name drift from the odds API if needed
export function getTeamMeta(name: string): TeamMeta {
  // direct match
  const meta = TEAM_META[name];
  if (meta) return meta;

  // simple aliases you encounter (extend as needed)
  const alias: Record<string, string> = {
    "Green Bay Packers": "Green Bay Packers",
    "New England Patriots": "New England Patriots",
    "LA Chargers": "Los Angeles Chargers",
    "LA Rams": "Los Angeles Rams",
    "Washington Football Team": "Washington Commanders",
  };

  const resolved = alias[name] ?? name;
  return TEAM_META[resolved] ?? {
    name,
    abbr: name.split(" ").map(s => s[0]).join("").slice(0,3).toUpperCase(),
    primary: "#374151",   // gray-700 fallback
    secondary: "#D1D5DB", // gray-300
  };
}