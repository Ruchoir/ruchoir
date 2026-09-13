import type { ButtonHTMLAttributes, ElementType, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconLeft?: IconName;
  iconRight?: IconName;
  fullWidth?: boolean;
  /**
   * The button is working. It shows a turning ring in place of its left icon and stops accepting
   * clicks.
   *
   * A button that is merely disabled while something happens looks like a button that ignored the
   * click, and the second click is somebody deciding the product is broken. Its width does not
   * change, because a button that resizes under the cursor is worse than one that says nothing.
   */
  loading?: boolean;
  as?: ElementType;
  children?: ReactNode;
};

/** Action button. One primary per view. */
export function Button({
  variant = "secondary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth,
  loading,
  as,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  const Tag = (as ?? "button") as ElementType;
  const ic = size === "lg" ? 18 : size === "sm" ? 14 : 16;
  return (
    <Tag
      className={`wc-btn wc-btn--${variant} wc-btn--${size}${fullWidth ? " wc-btn--full" : ""} ${className}`}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span className="wc-spinner" style={{ width: ic, height: ic }} aria-hidden="true" />
      ) : iconLeft ? (
        <Icon name={iconLeft} size={ic} />
      ) : null}
      {children ? <span>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={ic} /> : null}
    </Tag>
  );
}
