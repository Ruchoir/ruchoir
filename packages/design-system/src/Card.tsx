import type { HTMLAttributes, ReactNode } from "react";

export type CardVariant =
  | "default"
  | "interactive"
  | "raised"
  | "sunken";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  variant?: CardVariant;
  padded?: boolean;
  selected?: boolean;
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
};

/** Hairline container. Shadow is reserved for floating surfaces. */
export function Card({
  variant = "default",
  padded,
  selected,
  title,
  actions,
  footer,
  children,
  className = "",
  ...rest
}: CardProps) {
  const structured = title || actions || footer;
  return (
    <div
      className={`wc-card wc-card--${variant}${padded && !structured ? " wc-card--pad" : ""}${selected ? " wc-card--selected" : ""} ${className}`}
      {...rest}
    >
      {title || actions ? (
        <div className="wc-card__head">
          <span className="wc-card__title">{title}</span>
          {actions}
        </div>
      ) : null}
      {structured ? <div className="wc-card__body">{children}</div> : children}
      {footer ? <div className="wc-card__foot">{footer}</div> : null}
    </div>
  );
}
