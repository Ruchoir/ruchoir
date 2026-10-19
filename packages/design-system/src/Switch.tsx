import type { InputHTMLAttributes, ReactNode } from "react";

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: ReactNode;
  /** Push the label to the left and the track to the right, filling the row width. */
  reverse?: boolean;
};

/** Toggle with immediate effect (no confirmation step). Renders a native checkbox with role=switch. */
export function Switch({ label, reverse, disabled, className = "", ...rest }: SwitchProps) {
  return (
    <label className={`wc-sw${reverse ? " wc-sw--rev" : ""}${disabled ? " wc-sw--disabled" : ""} ${className}`}>
      <input type="checkbox" role="switch" disabled={disabled} {...rest} />
      <span className="wc-sw__track" />
      {label ? <span>{label}</span> : null}
    </label>
  );
}
