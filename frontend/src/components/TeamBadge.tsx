import React from "react";
import { getTeamMeta } from "../data/teams";
import { getTeamLogo } from "../data/teamLogos";

/** Helper: check if a color is dark (for auto-contrast text color) */
function isDark(hex: string): boolean {
  const c = (hex || "#000000").replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 140; // lower means darker color
}

type Align = "left" | "right";
type Size = "sm" | "md";

interface TeamBadgeProps {
  name: string;
  align?: Align;
  size?: Size;
  showName?: boolean;
}

export default function TeamBadge({
  name,
  align = "left",
  size = "md",
  showName = true,
}: TeamBadgeProps) {
  const meta = getTeamMeta(name);
  const logo = getTeamLogo(meta.name);

  const primary = meta.primary || "#374151";
  const textColor = isDark(primary) ? "#FFFFFF" : "#000000";
  const bgColor = primary;

  const row =
    align === "right"
      ? "flex items-center gap-2 justify-end text-right"
      : "flex items-center gap-2";

  const textSize = size === "sm" ? "text-xs" : "text-sm";

  const nameClasses = `
    ${textSize}
    font-semibold
    px-2
    py-0.5
    rounded
    leading-tight
    inline-flex
    items-center
  `;

  const logoWrapperClasses =
    "h-8 w-8 md:h-9 md:w-9 rounded-full flex items-center justify-center ring-1 ring-black/20 bg-white";

  const logoImgClasses = "h-6 w-6 md:h-7 md:w-7 object-contain";

  return (
    <div className={row}>
      {align === "left" && (
        <>
          <div className={logoWrapperClasses}>
            <img src={logo} alt={meta.abbr} className={logoImgClasses} />
          </div>
          {showName && (
            <span
              className={nameClasses}
              style={{
                color: textColor,
                backgroundColor: bgColor,
              }}
            >
              {meta.name}
            </span>
          )}
        </>
      )}

      {align === "right" && (
        <>
          {showName && (
            <span
              className={nameClasses}
              style={{
                color: textColor,
                backgroundColor: bgColor,
              }}
            >
              {meta.name}
            </span>
          )}
          <div className={logoWrapperClasses}>
            <img src={logo} alt={meta.abbr} className={logoImgClasses} />
          </div>
        </>
      )}
    </div>
  );
}