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

/** Counter or status dot. */
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
      className={`wc-badge wc-badge--${tone}${dot ? " wc-badge--dot" : ""} ${className}`}
    >
      {label}
    </span>
  );
}
