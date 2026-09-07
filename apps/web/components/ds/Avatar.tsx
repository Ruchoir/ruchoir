import type { CSSProperties } from "react";
import { type AvatarKind, avatarDataUri } from "@/lib/avatar";

export type Presence = "online" | "away" | "busy" | "offline";

export type AvatarProps = {
  name?: string;
  src?: string;
  size?: number;
  shape?: "square" | "round";
  presence?: Presence;
  /** Which DiceBear style to use for the default avatar (person/bot/workspace). */
  kind?: AvatarKind;
  className?: string;
  style?: CSSProperties;
};

/** Square avatar. Default image is generated locally with DiceBear, seeded by name. */
export function Avatar({
  name = "",
  src,
  size = 28,
  shape = "square",
  presence,
  kind = "person",
  className = "",
  style,
}: AvatarProps) {
  const generated = avatarDataUri(name, kind);
  const dot = size >= 36 ? 9 : size >= 24 ? 7 : size >= 18 ? 5 : 4;
  return (
    <span className={`wc-av-wrap ${className}`} style={{ width: size, height: size, ...style }}>
      <span
        className={`wc-av${shape === "round" ? " wc-av--round" : ""}`}
        style={{ width: size, height: size }}
      >
        {/* Static export (no Next image server at runtime) + self-hosted sources (data-URI avatars):
            next/image does not apply here, so a plain img is correct. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src ?? generated}
          alt={name}
          decoding="async"
          // While an uploaded photo is in flight the tile stays a plain surface rather than showing
          // the generated avatar underneath: swapping one face for another half a second later is
          // read as a flicker, where an empty tile filling in is read as loading. The generated one
          // is still the fallback, applied on the element itself when the photo cannot be fetched
          // (no avatar, or no longer a co-member), which needs no state and cannot loop: the data
          // URI is identical to what is already there.
          onError={(e) => {
            if (e.currentTarget.src !== generated) e.currentTarget.src = generated;
          }}
          style={src ? { background: "var(--surface-sunken)" } : undefined}
        />
      </span>
      {presence ? (
        <span
          className="wc-av__dot"
          style={{ width: dot, height: dot, background: `var(--presence-${presence})` }}
        />
      ) : null}
    </span>
  );
}
