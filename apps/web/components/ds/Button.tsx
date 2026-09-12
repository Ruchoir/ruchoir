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
  as,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const Tag = (as ?? "button") as ElementType;
  const ic = size === "lg" ? 18 : size === "sm" ? 14 : 16;
  return (
    <Tag
      className={`wc-btn wc-btn--${variant} wc-btn--${size}${fullWidth ? " wc-btn--full" : ""} ${className}`}
      {...rest}
    >
      {iconLeft ? <Icon name={iconLeft} size={ic} /> : null}
      {children ? <span>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={ic} /> : null}
    </Tag>
  );
}
