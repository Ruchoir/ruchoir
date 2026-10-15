import type { ReactNode, SelectHTMLAttributes } from "react";
import { Icon } from "./Icon";

export type SelectSize = "sm" | "md" | "lg";

export type SelectOption = string | { value: string; label: string };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: SelectSize;
  /** Convenience list of options; ignored when `children` is provided. */
  options?: SelectOption[];
  children?: ReactNode;
};

/** Styled wrapper around a native <select>, with a chevron affordance. */
export function Select({ size = "md", options = [], disabled, className = "", children, ...rest }: SelectProps) {
  return (
    <div className={`wc-sel wc-sel--${size}${disabled ? " wc-sel--disabled" : ""} ${className}`}>
      <select disabled={disabled} {...rest}>
        {children ??
          options.map((o) =>
            typeof o === "string" ? (
              <option key={o} value={o}>
                {o}
              </option>
            ) : (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ),
          )}
      </select>
      <Icon className="wc-sel__chev" name="chevron-down" size={14} />
    </div>
  );
}
