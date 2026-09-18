// Team colors and the small team tag used across the model pages.

// Primary / trim colors per team.
export const TEAM: Record<string, [string, string, string]> = {
  ARI: ["#97233F", "#FFFFFF", "#000000"], ATL: ["#A71930", "#FFFFFF", "#000000"],
  BAL: ["#241773", "#FFFFFF", "#9E7C0C"], BUF: ["#00338D", "#FFFFFF", "#C60C30"],
  CAR: ["#0085CA", "#FFFFFF", "#101820"], CHI: ["#0B162A", "#FFFFFF", "#C83803"],
  CIN: ["#FB4F14", "#000000", "#000000"], CLE: ["#311D00", "#FFFFFF", "#FF3C00"],
  DAL: ["#041E42", "#FFFFFF", "#869397"], DEN: ["#FB4F14", "#002244", "#002244"],
  DET: ["#0076B6", "#FFFFFF", "#B0B7BC"], GB: ["#203731", "#FFB612", "#FFB612"],
  HOU: ["#03202F", "#FFFFFF", "#A71930"], IND: ["#002C5F", "#FFFFFF", "#A2AAAD"],
  JAX: ["#006778", "#FFFFFF", "#D7A22A"], KC: ["#E31837", "#FFFFFF", "#FFB81C"],
  LAC: ["#0080C6", "#FFFFFF", "#FFC20E"], LA: ["#003594", "#FFD100", "#FFD100"], LAR: ["#003594", "#FFD100", "#FFD100"],
  LV: ["#000000", "#FFFFFF", "#A5ACAF"], MIA: ["#008E97", "#FFFFFF", "#FC4C02"],
  MIN: ["#4F2683", "#FFFFFF", "#FFC62F"], NE: ["#002244", "#FFFFFF", "#C60C30"],
  NO: ["#101820", "#D3BC8D", "#D3BC8D"], NYG: ["#0B2265", "#FFFFFF", "#A71930"],
  NYJ: ["#125740", "#FFFFFF", "#000000"], PHI: ["#004C54", "#FFFFFF", "#A5ACAF"],
  PIT: ["#101820", "#FFB612", "#FFB612"], SEA: ["#002244", "#69BE28", "#69BE28"],
  SF: ["#AA0000", "#FFFFFF", "#B3995D"], TB: ["#D50A0A", "#FFFFFF", "#34302B"],
  TEN: ["#0C2340", "#FFFFFF", "#4B92DB"], WAS: ["#5A1414", "#FFB612", "#FFB612"],
};

export function TeamTag({ team }: { team: string }) {
  const [bg, fg, trim] = TEAM[team] ?? ["#333", "#fff", "#999"];
  return (
    <span className="pf-tag" style={{ background: bg, color: fg, borderBottomColor: trim }}>
      {team}
    </span>
  );
}

