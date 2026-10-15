import type { InputHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type InputSize = "sm" | "md" | "lg";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: InputSize;
  icon?: IconName;
  suffix?: ReactNode;
  invalid?: boolean;
};

/** Single-line text field. */
export function Input({
  size = "md",
  icon,
  suffix,
  invalid,
  disabled,
  className = "",
  ...rest
}: InputProps) {
  const { "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, id, placeholder, ...inputRest } = rest;
  // A placeholder is not an accessible name (WCAG 4.1.2). When the field carries no explicit label
  // and no id (so no external <label for> can target it) - typical of search/filter fields - fall
  // back to the placeholder so the control is still announced. Labelled fields (with an id) keep
  // their real label untouched.
  const fallbackLabel = !ariaLabel && !ariaLabelledBy && !id && placeholder ? placeholder : undefined;
  return (
    <div
      className={`wc-inp wc-inp--${size}${invalid ? " wc-inp--invalid" : ""}${disabled ? " wc-inp--disabled" : ""} ${className}`}
    >
      {icon ? <Icon className="wc-inp__ico" name={icon} size={size === "lg" ? 18 : 14} /> : null}
      <input
        id={id}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel ?? fallbackLabel}
        aria-labelledby={ariaLabelledBy}
        placeholder={placeholder}
        {...inputRest}
      />
      {suffix ? <span className="wc-inp__suffix">{suffix}</span> : null}
    </div>
  );
}
