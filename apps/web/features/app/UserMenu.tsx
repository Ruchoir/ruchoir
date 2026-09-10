"use client";

import { type CSSProperties, type RefObject } from "react";
import { Avatar, Icon, Popover } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { PresenceChoice } from "@/lib/data";
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

/**
 * The availability entries, and the dot each one produces.
 *
 * "En ligne" is the default, and it is the one that writes no override at all: presence then
 * follows the connection, which is what being online means. That mechanism is deliberately not
 * surfaced. There is no "automatic" entry to pick, because automatic is not a state anyone should
 * have to reason about, it is simply what the product does when you have not asked for anything
 * else. The other three are the cases where you do mean to say something the connection does not:
 * here but away, here but busy, here but not showing it.
 *
 * What changed underneath is that "En ligne" used to store a permanent `active` override, which
 * left everyone lit whether they were connected or not and could not be undone from the menu.
 */
const CHOICES: { key: PresenceChoice; label: string; dot: Presence }[] = [
  { key: "auto", label: "En ligne", dot: "online" },
  { key: "away", label: "Absent", dot: "away" },
  { key: "busy", label: "Ne pas déranger", dot: "busy" },
  { key: "invisible", label: "Invisible", dot: "offline" },
];

function hover(on: boolean) {
  return (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = on ? "var(--surface-hover)" : "transparent";
  };
}

export type UserMenuProps = {
  currentUser: string;
  /** The dot: what other people see, as the server computes it. */
  presence: Presence;
  /** The instruction: which entry of the availability list is in force. */
  choice: PresenceChoice;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onSetPresence: (choice: PresenceChoice) => void;
  onOpenProfile: () => void;
  onEditProfile: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
};

/** The signed-in user's menu: presence and profile actions. */
export function UserMenu({
  currentUser,
  presence,
  choice,
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
          {CHOICES.map((c) => {
            const on = c.key === choice;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => run(() => onSetPresence(c.key))}
                style={{ ...item, background: on ? "var(--surface-selected)" : "transparent" }}
                onMouseEnter={hover(!on)}
                onMouseLeave={hover(false)}
              >
                <span style={{ width: 10, height: 10, borderRadius: "var(--radius-full)", background: `var(--presence-${c.dot})`, border: c.dot === "offline" ? "1px solid var(--border-strong)" : undefined }} />
                <span style={{ flex: 1, minWidth: 0, color: on ? "var(--text-accent)" : "var(--text-body)" }}>{c.label}</span>
                {on ? <Icon name="check" size={14} style={{ color: "var(--text-accent)" }} /> : null}
              </button>
            );
          })}
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
