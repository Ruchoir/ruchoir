import type { ReactNode } from "react";

/** `mention`: something addressed to the reader (peach, with an "@"), set apart from mere activity. */
export type BadgeTone = "accent" | "neutral" | "strong" | "success" | "warning" | "danger" | "mention";

export type BadgeProps = {
  count?: number;
  max?: number;
  tone?: BadgeTone;
  dot?: boolean;
  children?: ReactNode;
  className?: string;
};

/**
 * Counter or status dot.
 *
 * Keyed on what it shows, so a badge that appears or whose number changes plays a short bump: the
 * one moment a number deserves the eye is when it moves.
 */
export function Badge({
  count,
  max = 99,
  tone = "accent",
  dot,
  children,
  className = "",
}: BadgeProps) {
  const number = count != null && count > max ? `${max}+` : count;
  const label = dot ? null : (children ?? (tone === "mention" && number != null ? `@${number}` : number));
  return (
    <span
      key={dot ? "dot" : String(label)}
      className={`wc-badge wc-badge--${tone}${dot ? " wc-badge--dot" : ""} ${className}`}
    >
      {label}
    </span>
  );
}
