import type { InputHTMLAttributes, ReactNode } from "react";

export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: ReactNode;
  description?: ReactNode;
};

/** Radio button. The filled dot is drawn by thickening the ring border when checked. */
export function Radio({ label, description, disabled, className = "", ...rest }: RadioProps) {
  return (
    <label className={`wc-rd${disabled ? " wc-rd--disabled" : ""} ${className}`}>
      <input type="radio" disabled={disabled} {...rest} />
      <span className="wc-rd__dot" />
      {label || description ? (
        <span className="wc-rd__txt">
          {label ? <span>{label}</span> : null}
          {description ? <span className="wc-rd__desc">{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
