import type { ButtonHTMLAttributes, Ref } from "react";
import { Icon, type IconName } from "./Icon";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "outlined" | "accent";

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  ref?: Ref<HTMLButtonElement>;
};

/** Square icon-only button. `label` is required for accessibility. */
export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  className = "",
  ref,
  ...rest
}: IconButtonProps) {
  const ic = size === "lg" ? 20 : size === "sm" ? 14 : 16;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`wc-ibtn wc-ibtn--${size} wc-ibtn--${variant} ${className}`}
      {...rest}
    >
      <Icon name={icon} size={ic} />
    </button>
  );
}
