import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type EmptyStateSize = "hero" | "compact";

export type EmptyStateProps = {
  /** Optional icon name (rendered in a soft badge in `hero`, plain in `compact`). */
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
 * drops straight into a `flex: 1` container. `hero` puts the icon in a soft badge with a larger
 * title; `compact` is tighter for floating and inline surfaces.
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
        hero ? (
          <span
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              marginBottom: 2,
              borderRadius: "var(--radius-lg)",
              background: "var(--surface-sunken)",
              color: "var(--text-subtle)",
            }}
          >
            <Icon name={icon} size={26} />
          </span>
        ) : (
          <Icon name={icon} size={22} style={{ color: "var(--grey-300)" }} />
        )
      ) : null}
      {title ? (
        <div style={{ fontSize: hero ? 16 : 14, fontWeight: 600, color: "var(--text-strong)" }}>{title}</div>
      ) : null}
      {description ? (
        <p
          style={{
            margin: 0,
            fontSize: hero ? 13 : 12.5,
            color: "var(--text-muted)",
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
