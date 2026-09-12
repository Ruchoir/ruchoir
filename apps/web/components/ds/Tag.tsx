import type { MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type TagTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export type TagProps = {
  tone?: TagTone;
  icon?: IconName;
  mono?: boolean;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  className?: string;
};

/** Metadata label: import provenance, file state, role. */
export function Tag({
  tone = "neutral",
  icon,
  mono,
  onRemove,
  children,
  className = "",
}: TagProps) {
  return (
    <span className={`wc-tag wc-tag--${tone}${mono ? " wc-tag--mono" : ""} ${className}`}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
      {onRemove ? (
        <button className="wc-tag__x" aria-label="Retirer" onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </span>
  );
}
