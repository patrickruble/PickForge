// src/components/TeamBadge.tsx
import React from "react";
import { getTeamMeta } from "../data/teams";
import { getTeamLogo } from "../data/teamLogos";

function isDark(hex: string): boolean {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 140;
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

  const textColor = isDark(meta.primary) ? "#FFFFFF" : "#000000";
  const bgColor = meta.primary || "#374151";

  const row =
    align === "right"
      ? "flex items-center gap-2 justify-end text-right"
      : "flex items-center gap-2";

  // Slightly smaller + constrained on mobile, full size on sm+
  const textSize = size === "sm" ? "text-[11px] sm:text-xs" : "text-xs sm:text-sm";

  const pillClasses = [
    textSize,
    "team-pill",
    "inline-flex",
    "items-center",
    "justify-center",
    "font-semibold",
    "px-2.5",
    "py-0.5",
    "rounded-md",
    "max-w-[112px]", // keeps PIT / WAS / TB from blowing out layout on phone
    "sm:max-w-none",
    "truncate",
    "text-center",
    "leading-snug",
  ].join(" ");

  return (
    <div className={row}>
      {align === "left" && (
        <>
          <div
            className="h-8 w-8 md:h-9 md:w-9 rounded-full flex items-center justify-center ring-1 ring-black/20 bg-white"
          >
            <img
              src={logo}
              alt={meta.abbr}
              className="h-6 w-6 md:h-7 md:w-7 object-contain"
            />
          </div>
          {showName && (
            <span
              className={pillClasses}
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
              className={pillClasses}
              style={{
                color: textColor,
                backgroundColor: bgColor,
              }}
            >
              {meta.name}
            </span>
          )}
          <div
            className="h-8 w-8 md:h-9 md:w-9 rounded-full flex items-center justify-center ring-1 ring-black/20 bg-white"
          >
            <img
              src={logo}
              alt={meta.abbr}
              className="h-6 w-6 md:h-7 md:w-7 object-contain"
            />
          </div>
        </>
      )}
    </div>
  );
}