"use client";

import { type CSSProperties, type RefObject } from "react";
import { Avatar, Icon, Popover } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { presenceLabel } from "./presence";
import { getAvatar } from "@/lib/data";

const panel: CSSProperties = {
  width: 260,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
  overflow: "hidden",
};

const section: CSSProperties = { padding: 8, borderBottom: "1px solid var(--border-subtle)" };
const label: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--text-subtle)",
  padding: "2px 4px 6px",
};

const item: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--text-body)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  textAlign: "left",
  cursor: "pointer",
};

const PRESENCES: { key: Presence; label: string }[] = [
  { key: "online", label: "En ligne" },
  { key: "away", label: "Absent" },
  { key: "busy", label: "Ne pas déranger" },
  { key: "offline", label: "Invisible" },
];

function hover(on: boolean) {
  return (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = on ? "var(--surface-hover)" : "transparent";
  };
}

export type UserMenuProps = {
  currentUser: string;
  presence: Presence;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onSetPresence: (p: Presence) => void;
  onOpenProfile: () => void;
  onEditProfile: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
};

/** The signed-in user's menu: presence and profile actions. */
export function UserMenu({
  currentUser,
  presence,
  anchorRef,
  open,
  onClose,
  onSetPresence,
  onOpenProfile,
  onEditProfile,
  onOpenSettings,
  onLogout,
}: UserMenuProps) {
  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} placement="top" align="start">
      <div style={panel}>
        <div style={{ ...section, display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar name={currentUser} src={getAvatar(currentUser)} size={40} presence={presence} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-strong)" }}>{currentUser}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{presenceLabel(presence)}</div>
          </div>
        </div>

        <div style={section}>
          <div style={label}>Disponibilité</div>
          {PRESENCES.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => run(() => onSetPresence(p.key))}
              style={{ ...item, background: p.key === presence ? "var(--surface-selected)" : "transparent" }}
              onMouseEnter={hover(p.key !== presence)}
              onMouseLeave={hover(false)}
            >
              <span style={{ width: 10, height: 10, borderRadius: "var(--radius-full)", background: `var(--presence-${p.key})`, border: p.key === "offline" ? "1px solid var(--border-strong)" : undefined }} />
              <span style={{ flex: 1, color: p.key === presence ? "var(--text-accent)" : "var(--text-body)" }}>{p.label}</span>
              {p.key === presence ? <Icon name="check" size={14} style={{ color: "var(--text-accent)" }} /> : null}
            </button>
          ))}
        </div>

        <div style={{ padding: 4 }}>
          <button type="button" onClick={() => run(onOpenProfile)} style={item} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
            <Icon name="smile" size={14} /> Voir mon profil
          </button>
          <button type="button" onClick={() => run(onEditProfile)} style={item} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
            <Icon name="square-pen" size={14} /> Modifier le profil
          </button>
          <button type="button" onClick={() => run(onOpenSettings)} style={item} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
            <Icon name="settings" size={14} /> Préférences
          </button>
          <button type="button" onClick={() => run(onLogout)} style={{ ...item, color: "var(--status-danger-fg)" }} onMouseEnter={hover(true)} onMouseLeave={hover(false)}>
            <Icon name="log-out" size={14} /> Se déconnecter
          </button>
        </div>
      </div>
    </Popover>
  );
}
