import type { AnchorHTMLAttributes, CSSProperties } from "react";
import { Icon } from "./Icon";
import type { IconButtonSize, IconButtonVariant } from "./IconButton";

export type IconLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  icon: string;
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
};

/**
 * An icon-only link that looks exactly like an {@link IconButton}.
 *
 * Downloading a file and opening it in a tab are navigations, not actions: they want an `<a>`, so
 * that the middle click, the context menu and "open in a new tab" all behave. Wrapping an
 * `IconButton` in an anchor would nest a `<button>` inside an `<a>`, which is invalid and leaves
 * assistive technology announcing two overlapping controls. This shares the button's styling instead.
 */
export function IconLink({ icon, label, size = "md", variant = "ghost", className = "", style, ...rest }: IconLinkProps) {
  const glyph = size === "lg" ? 20 : size === "sm" ? 14 : 16;
  const inline: CSSProperties = { display: "inline-flex", textDecoration: "none", ...style };
  return (
    <a
      aria-label={label}
      title={label}
      className={`wc-ibtn wc-ibtn--${size} wc-ibtn--${variant} ${className}`}
      style={inline}
      {...rest}
    >
      <Icon name={icon} size={glyph} />
    </a>
  );
}
