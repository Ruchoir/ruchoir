import type { ReactNode } from "react";

export type BadgeTone = "accent" | "neutral" | "strong" | "success" | "warning" | "danger";

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
  const label = dot ? null : (children ?? (count != null && count > max ? `${max}+` : count));
  return (
    <span
      key={dot ? "dot" : String(label)}
      className={`wc-badge wc-badge--${tone}${dot ? " wc-badge--dot" : ""} ${className}`}
    >
      {label}
    </span>
  );
}
