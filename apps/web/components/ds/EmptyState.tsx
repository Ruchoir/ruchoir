import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type EmptyStateSize = "hero" | "compact";

export type EmptyStateProps = {
  /** Optional icon name, drawn as a sticker (larger in `hero`, smaller in `compact`). */
  icon?: IconName;
  title?: ReactNode;
  description?: ReactNode;
  /** Optional call to action (e.g. a Button) shown below the text. */
  action?: ReactNode;
  /** `hero` fills a whole view; `compact` suits popovers, side panels and search dropdowns. */
  size?: EmptyStateSize;
  className?: string;
  style?: CSSProperties;
};

/**
 * Consistent empty / no-results placeholder used across the app. Centered on both axes so it
 * drops straight into a `flex: 1` container. `hero` has a larger sticker and a bold title; `compact` is tighter for floating and inline surfaces.
 */
export function EmptyState({ icon, title, description, action, size = "hero", className = "", style }: EmptyStateProps) {
  const hero = size === "hero";
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: hero ? 10 : 6,
        padding: hero ? 40 : "24px 16px",
        margin: "0 auto",
        ...style,
      }}
    >
      {icon ? (
        // A sticker: the icon on the theme's pastel, edged in ink, set a little askew on an offset
        // shadow. The design system's way of drawing something small with character.
        <span
          aria-hidden
          className="wc-sticker"
          style={{
            width: hero ? 64 : 40,
            height: hero ? 64 : 40,
            marginBottom: hero ? 8 : 4,
            boxShadow: hero ? "var(--shadow-popover)" : "var(--shadow-offset-sm)",
          }}
        >
          <Icon name={icon} size={hero ? 28 : 18} />
        </span>
      ) : null}
      {title ? (
        <div style={{ fontSize: hero ? 20 : 14, fontWeight: hero ? 700 : 600, letterSpacing: hero ? "var(--tracking-tight)" : undefined, color: "var(--text-strong)" }}>{title}</div>
      ) : null}
      {description ? (
        <p
          style={{
            margin: 0,
            fontSize: hero ? 14 : 12.5,
            color: hero ? "var(--text-body)" : "var(--text-muted)",
            maxWidth: hero ? 340 : 260,
            lineHeight: "var(--leading-snug)",
          }}
        >
          {description}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: hero ? 8 : 6 }}>{action}</div> : null}
    </div>
  );
}
