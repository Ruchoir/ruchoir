import type { MouseEventHandler, ReactNode } from "react";
import { BrandIcon, type BrandName } from "./BrandIcon";
import { Icon, type IconName } from "./Icon";

export type TagTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export type TagProps = {
  tone?: TagTone;
  icon?: IconName;
  /**
   * A product logo in the leading slot, for a provenance tag ("imported from Slack"). Takes the
   * place of `icon`: a source is named by its own mark, not by a generic one alongside it.
   */
  brand?: BrandName;
  mono?: boolean;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
  /** Accessible name of the remove button; passed in, like every other string this library shows. */
  /**
   * Accessible name of the remove button.
   *
   * No default: the design system carries no dictionary, and a French word defaulted in here would
   * be read out to every reader in every language. A tag that can be removed names its button.
   */
  removeLabel?: string;
  children?: ReactNode;
  className?: string;
};

/** Metadata label: import provenance, file state, role. */
export function Tag({
  tone = "neutral",
  icon,
  brand,
  mono,
  onRemove,
  removeLabel,
  children,
  className = "",
}: TagProps) {
  return (
    <span className={`wc-tag wc-tag--${tone}${mono ? " wc-tag--mono" : ""} ${className}`}>
      {brand ? <BrandIcon name={brand} size={12} /> : icon ? <Icon name={icon} size={12} /> : null}
      {children}
      {onRemove ? (
        <button className="wc-tag__x" aria-label={removeLabel} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </span>
  );
}
