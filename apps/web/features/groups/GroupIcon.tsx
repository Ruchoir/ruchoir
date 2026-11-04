"use client";

import { Icon } from "@/components/ds";
import { ROLE_COLOURS } from "../settings/RoleEditor";

/** The pastel a group wears, always the same for the same group. */
export function groupColour(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ROLE_COLOURS[hash % ROLE_COLOURS.length];
}

/**
 * A group's square: one of the pastels, always the same for the same group. `framed` sets it in a
 * light frame, for when it sits on a field of its own colour (the group panel's hero).
 */
export function GroupIcon({ id, size = 36, framed = false }: { id: string; size?: number; framed?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: "var(--radius-md)",
        background: `var(--${groupColour(id)})`,
        color: "var(--on-pastel)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        ...(framed ? { border: "3px solid var(--surface-raised)", boxShadow: "0 0 0 1px var(--on-pastel)" } : {}),
      }}
    >
      <Icon name="users" size={Math.round(size / 2)} />
    </span>
  );
}
