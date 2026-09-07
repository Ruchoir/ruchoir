import { type CSSProperties, useRef, useState } from "react";
import { Avatar, Badge, IconButton, Tooltip } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { Workspace } from "@/lib/data";
import { UserMenu } from "./UserMenu";

const rail: CSSProperties = {
  width: "var(--rail-width)",
  flex: "none",
  background: "var(--grey-100)",
  borderRight: "1px solid var(--border-subtle)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "8px 0",
  gap: 6,
};

/** Wrapper that lets the unread indicator sit on the tile's corner. */
const wsSlot: CSSProperties = { position: "relative", display: "block" };

/** Numbered badge (mentions), pinned to the tile's top-right. */
const wsIndicator: CSSProperties = {
  position: "absolute",
  top: -2,
  right: -2,
  pointerEvents: "none",
};

/**
 * The activity dot: same corner, but ringed in the rail's own colour so it reads as a mark on the
 * tile rather than part of the artwork underneath. The ring lives here and not in the badge tone
 * because only the surface knows its own background.
 */
const wsDot: CSSProperties = {
  position: "absolute",
  top: -1,
  right: -1,
  display: "inline-flex",
  lineHeight: 0,
  borderRadius: "var(--radius-full)",
  boxShadow: "0 0 0 2px var(--grey-100)",
  pointerEvents: "none",
};

function wsButton(on: boolean): CSSProperties {
  return {
    width: 40,
    height: 40,
    borderRadius: "var(--radius-md)",
    border: 0,
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    background: "transparent",
    boxShadow: on ? "0 0 0 2px var(--terracotta-500)" : "none",
    transition: "box-shadow var(--duration-fast) var(--ease-out)",
  };
}

export type WorkspaceRailProps = {
  workspaces: Workspace[];
  active: string;
  currentUser: string;
  presence: Presence;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSetPresence: (p: Presence) => void;
  onOpenOwnProfile: () => void;
  onEditOwnProfile: () => void;
  onOpenSettings: () => void;
  onHelp: () => void;
  onLogout: () => void;
};

/** Left-most rail: one square per workspace, plus help and the signed-in user. */
export function WorkspaceRail({
  workspaces,
  active,
  currentUser,
  presence,
  onSelect,
  onNew,
  onSetPresence,
  onOpenOwnProfile,
  onEditOwnProfile,
  onOpenSettings,
  onHelp,
  onLogout,
}: WorkspaceRailProps) {
  const [userMenu, setUserMenu] = useState(false);
  const userRef = useRef<HTMLButtonElement>(null);

  return (
    <div style={rail}>
      {workspaces.map((w) => {
        // Nothing on the space being read: its per-channel badges are already in the sidebar, and a
        // counter fetched at boot would go stale the moment its owner starts reading.
        const background = w.id !== active;
        const mentions = background ? w.mentions : 0;
        const activity = background && mentions === 0 && w.unread > 0;
        const label =
          mentions > 0
            ? `${w.name}, ${mentions} notification${mentions > 1 ? "s" : ""}`
            : activity
              ? `${w.name}, activité non lue`
              : w.name;
        return (
          <Tooltip key={w.id} label={label} side="right">
            <span style={wsSlot}>
              <button style={wsButton(w.id === active)} onClick={() => onSelect(w.id)} aria-label={label}>
                <Avatar name={w.name} src={w.iconUrl} kind="workspace" size={36} />
              </button>
              {mentions > 0 ? (
                <span style={wsIndicator}>
                  <Badge count={mentions} tone="accent" />
                </span>
              ) : null}
              {activity ? (
                <span style={wsDot}>
                  <Badge dot tone="strong" />
                </span>
              ) : null}
            </span>
          </Tooltip>
        );
      })}
      <Tooltip label="Nouvel espace" side="right">
        <IconButton icon="plus" label="Nouvel espace" onClick={onNew} />
      </Tooltip>
      <div style={{ flex: 1 }} />
      <Tooltip label="Aide" side="right">
        <IconButton icon="life-buoy" label="Aide" onClick={onHelp} />
      </Tooltip>
      <Tooltip label="Mon profil" side="right">
        <button
          ref={userRef}
          onClick={() => setUserMenu((o) => !o)}
          aria-label="Mon profil et statut"
          aria-expanded={userMenu}
          style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}
        >
          <Avatar name={currentUser} size={36} presence={presence} />
        </button>
      </Tooltip>
      <UserMenu
        currentUser={currentUser}
        presence={presence}
        anchorRef={userRef}
        open={userMenu}
        onClose={() => setUserMenu(false)}
        onSetPresence={onSetPresence}
        onOpenProfile={onOpenOwnProfile}
        onEditProfile={onEditOwnProfile}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
      />
    </div>
  );
}
