import { useEffect, type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";

export type DialogSize = "sm" | "md" | "lg";

export type DialogProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  open?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: DialogSize;
  footer?: ReactNode;
  onClose?: () => void;
  /**
   * Accessible name of the close button.
   *
   * Passed in rather than looked up: the design system carries no dictionary, and reaching for the
   * application's translation runtime from here would tie a component library to one app.
   */
  closeLabel?: string;
  children?: ReactNode;
};

/** Centered modal dialog. Closes on scrim click, close button, and Escape. */
export function Dialog({
  open = true,
  title,
  subtitle,
  size = "md",
  footer,
  onClose,
  children,
  className = "",
  // Default in the source language: the design system carries no dictionary, so a caller that
  // cares passes the translated label, and one that does not still gets an accessible name.
  closeLabel = "Fermer",
  ...rest
}: DialogProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="wc-dlg__scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        className={`wc-dlg wc-dlg--${size} ${className}`}
        {...rest}
      >
        {title ? (
          <div className="wc-dlg__head">
            <div className="wc-dlg__ttl">
              {title}
              {subtitle ? <div className="wc-dlg__sub">{subtitle}</div> : null}
            </div>
            {onClose ? (
              <button type="button" className="wc-dlg__x" aria-label={closeLabel} onClick={onClose}>
                <Icon name="x" size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="wc-dlg__body">{children}</div>
        {footer ? <div className="wc-dlg__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
