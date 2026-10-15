import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
};

/** Checkbox with an optional label/description column and indeterminate support. */
export function Checkbox({ label, description, indeterminate, disabled, className = "", ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <label className={`wc-cb${disabled ? " wc-cb--disabled" : ""} ${className}`}>
      <input ref={ref} type="checkbox" disabled={disabled} {...rest} />
      <span className="wc-cb__box">
        <Icon name={indeterminate ? "minus" : "check"} size={12} />
      </span>
      {label || description ? (
        <span className="wc-cb__txt">
          {label ? <span>{label}</span> : null}
          {description ? <span className="wc-cb__desc">{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
