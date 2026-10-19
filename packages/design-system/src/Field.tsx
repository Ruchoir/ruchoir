import type { HTMLAttributes, ReactNode } from "react";

export type FieldProps = HTMLAttributes<HTMLDivElement> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Show a muted "facultatif" marker next to the label. */
  optional?: boolean;
  htmlFor?: string;
  children: ReactNode;
};

/** Label + hint + error wrapper around a single form control. */
export function Field({ label, hint, error, optional, htmlFor, children, className = "", ...rest }: FieldProps) {
  return (
    <div className={`wc-field ${className}`} {...rest}>
      {label ? (
        <label className="wc-field__label" htmlFor={htmlFor}>
          {label}
          {optional ? <span className="wc-field__opt">facultatif</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span className="wc-field__err">{error}</span>
      ) : hint ? (
        <span className="wc-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
