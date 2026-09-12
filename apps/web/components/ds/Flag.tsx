import type { CSSProperties } from "react";

/**
 * Flags, drawn here rather than fetched or typed as emoji.
 *
 * Emoji flags looked right on the machine they were written on and nowhere else: Chrome and Edge on
 * Windows carry no flag glyphs at all and fall back to the two regional letters, so half the readers
 * would have seen "GB" where the design says a flag. An icon that renders differently per operating
 * system is not an icon.
 *
 * Six small SVGs, inline: no network request (a self-hosted instance makes none), no dependency, and
 * no sprite sheet to keep in step. They are the simplified civil flags, without coats of arms, which
 * is what survives being drawn 20 pixels wide anyway.
 *
 * A flag is a country and a language is not, which the menu answers by putting the endonym next to
 * it: the flag is the icon people aim at, the name is what it means.
 */

export type FlagCode = "fr" | "en" | "es" | "de" | "it" | "pl";

const base: CSSProperties = {
  display: "block",
  flex: "none",
  borderRadius: 2,
  // Pale flags (Poland's lower half, the white in several others) would otherwise dissolve into a
  // light background: a hairline keeps the shape without drawing attention to itself.
  boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text-default) 18%, transparent)",
};

/** One flag, `size` being its width; the height follows the 3:2 the drawings use. */
export function Flag({ code, size = 20, style }: { code: FlagCode; size?: number; style?: CSSProperties }) {
  const shared = {
    width: size,
    height: Math.round((size * 2) / 3),
    viewBox: "0 0 30 20",
    role: "presentation" as const,
    "aria-hidden": true,
    style: { ...base, ...style },
  };

  switch (code) {
    case "fr":
      return (
        <svg {...shared}>
          <rect width="10" height="20" fill="#000091" />
          <rect x="10" width="10" height="20" fill="#fff" />
          <rect x="20" width="10" height="20" fill="#e1000f" />
        </svg>
      );
    case "it":
      return (
        <svg {...shared}>
          <rect width="10" height="20" fill="#008c45" />
          <rect x="10" width="10" height="20" fill="#f4f9ff" />
          <rect x="20" width="10" height="20" fill="#cd212a" />
        </svg>
      );
    case "de":
      return (
        <svg {...shared}>
          <rect width="30" height="6.67" fill="#000" />
          <rect y="6.67" width="30" height="6.67" fill="#dd0000" />
          <rect y="13.33" width="30" height="6.67" fill="#ffce00" />
        </svg>
      );
    case "es":
      return (
        <svg {...shared}>
          <rect width="30" height="20" fill="#aa151b" />
          <rect y="5" width="30" height="10" fill="#f1bf00" />
        </svg>
      );
    case "pl":
      return (
        <svg {...shared}>
          <rect width="30" height="10" fill="#fff" />
          <rect y="10" width="30" height="10" fill="#dc143c" />
        </svg>
      );
    case "en":
      // The Union Flag, at 30x20. The red saltire is counterchanged (offset within the white one),
      // which is the detail that separates a drawn flag from an approximation of one.
      return (
        <svg {...shared}>
          <clipPath id="ruchoir-flag-uk">
            <rect width="30" height="20" />
          </clipPath>
          <g clipPath="url(#ruchoir-flag-uk)">
            <rect width="30" height="20" fill="#012169" />
            <path d="M0,0 L30,20 M30,0 L0,20" stroke="#fff" strokeWidth="4" />
            <path
              d="M0,0 L30,20 M30,0 L0,20"
              stroke="#c8102e"
              strokeWidth="2.4"
              clipPath="url(#ruchoir-flag-uk)"
            />
            <path d="M15,0 V20 M0,10 H30" stroke="#fff" strokeWidth="6.6" />
            <path d="M15,0 V20 M0,10 H30" stroke="#c8102e" strokeWidth="4" />
          </g>
        </svg>
      );
  }
}
