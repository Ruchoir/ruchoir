import { type CSSProperties, useRef, useState } from "react";
import { useDragReorder } from "./useDragReorder";
import { Avatar, Badge, IconButton, Tooltip } from "@/components/ds";
import type { Presence } from "@/components/ds";
import type { PresenceChoice } from "@/lib/data";
import type { Workspace } from "@/lib/data";
import { UserMenu } from "./UserMenu";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";

const rail: CSSProperties = {
  width: "var(--rail-width)",
  flex: "none",
  background: "var(--surface-canvas)",
  borderRight: "1.5px solid var(--border-subtle)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "12px 0",
  gap: 10,
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
  boxShadow: "0 0 0 2px var(--surface-canvas)",
  pointerEvents: "none",
};

const wsButton: CSSProperties = {
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
};

export type WorkspaceRailProps = {
  workspaces: Workspace[];
  active: string;
  currentUser: string;
  /** The dot on the user's own avatar: their effective presence, as others see it. */
  presence: Presence;
  /** Which availability entry is in force, for the menu to mark. */
  presenceChoice: PresenceChoice;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSetPresence: (choice: PresenceChoice) => void;
  onOpenOwnProfile: () => void;
  onEditOwnProfile: () => void;
  onOpenSettings: () => void;
  /** Open the instance administration. Absent unless the signed-in account administers it. */
  onOpenInstanceAdmin?: () => void;
  onHelp: () => void;
  onLogout: () => void;
  /**
   * Move a space to a new position in the rail. Absent leaves the rail fixed, which is what it was.
   *
   * The order is the caller's to persist: the rail says what was asked for, not where it is stored.
   */
  onReorder?: (spaceId: string, toIndex: number) => void;
};

/** Left-most rail: one square per workspace, plus help and the signed-in user. */
export function WorkspaceRail({
  workspaces,
  active,
  currentUser,
  presence,
  presenceChoice,
  onSelect,
  onNew,
  onSetPresence,
  onOpenOwnProfile,
  onEditOwnProfile,
  onOpenSettings,
  onOpenInstanceAdmin,
  onHelp,
  onLogout,
  onReorder,
}: WorkspaceRailProps) {
  const { t } = useTranslation();
  const [userMenu, setUserMenu] = useState(false);
  const userRef = useRef<HTMLButtonElement>(null);

  const move = (spaceId: string, toIndex: number) => {
    const from = workspaces.findIndex((w) => w.id === spaceId);
    const to = Math.max(0, Math.min(workspaces.length - 1, toIndex));
    if (from === -1 || from === to) return;
    onReorder?.(spaceId, to);
  };
  // Pressed and moved, a space follows the pointer and the others make room for it.
  const reorder = useDragReorder({ count: workspaces.length, onMove: (from, to) => move(workspaces[from].id, to) });

  return (
    <div style={rail}>
      {workspaces.map((w, index) => {
        // Nothing on the space being read: its per-channel badges are already in the sidebar, and a
        // counter fetched at boot would go stale the moment its owner starts reading.
        const background = w.id !== active;
        const mentions = background ? w.mentions : 0;
        const activity = background && mentions === 0 && w.unread > 0;
        const label =
          mentions > 0
            ? `${w.name}, ${mentions} notification${mentions > 1 ? "s" : ""}`
            : activity
              ? t("rail.unreadActivity", { name: w.name })
              : w.name;
        return (
          <Tooltip key={w.id} label={label} side="right" disabled={reorder.dragging}>
            <span ref={reorder.itemRef(index)} style={{ ...wsSlot, ...reorder.itemStyle(index) }}>
              <button
                // The ring, the offset shadow of the open space and the tilt under the pointer are
                // drawn by the class (components.css), which can say :hover.
                className="wc-rail-space"
                style={wsButton}
                aria-current={w.id === active ? "true" : undefined}
                onClick={() => onSelect(w.id)}
                aria-label={label}
                // Reordering is a pointer gesture *and* a keyboard one: alt with the arrow keys moves
                // the focused space, so the arrangement is not a feature reserved to pointers.
                onPointerDown={onReorder ? reorder.onPointerDown(index) : undefined}
                // The icon is an image, which the browser would otherwise drag out as a file.
                onDragStart={(e) => e.preventDefault()}
                onKeyDown={(e) => {
                  if (!onReorder || !e.altKey) return;
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    move(w.id, index - 1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    move(w.id, index + 1);
                  }
                }}
              >
                <Avatar name={w.name} src={w.iconUrl} kind="workspace" size={36} />
              </button>
              {mentions > 0 ? (
                <span style={wsIndicator} className="wc-rail-ind">
                  <Badge count={mentions} tone="mention" />
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
      <Tooltip label={t("shell.newSpace")} side="right">
        <IconButton icon="plus" label={t("shell.newSpace")} onClick={onNew} />
      </Tooltip>
      <div style={{ flex: 1 }} />
      <Tooltip label={t("common.help")} side="right">
        <IconButton icon="life-buoy" label={t("common.help")} onClick={onHelp} />
      </Tooltip>
      <Tooltip label={t("shell.myProfile")} side="right">
        <button
          ref={userRef}
          onClick={() => setUserMenu((o) => !o)}
          aria-label={t("shell.myProfileAndStatus")}
          aria-expanded={userMenu}
          className="wc-rail-space"
          style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}
        >
          <Avatar name={currentUser} src={getAvatar(currentUser)} size={36} presence={presence} />
        </button>
      </Tooltip>
      <UserMenu
        currentUser={currentUser}
        presence={presence}
        choice={presenceChoice}
        anchorRef={userRef}
        open={userMenu}
        onClose={() => setUserMenu(false)}
        onSetPresence={onSetPresence}
        onOpenProfile={onOpenOwnProfile}
        onEditProfile={onEditOwnProfile}
        onOpenSettings={onOpenSettings}
        onOpenInstanceAdmin={onOpenInstanceAdmin}
        onLogout={onLogout}
      />
    </div>
  );
}
