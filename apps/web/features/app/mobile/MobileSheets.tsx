"use client";

/**
 * The touch forms of two menus the desktop draws as a rail and a popover: which space is open, and
 * the signed-in person's own menu. On a phone and a tablet both rise from the bottom edge, as rows
 * a thumb can hit, with the space's name (not only its icon) in the switcher.
 */

import { Avatar, Badge, Icon, type Presence, Sheet, SheetGroup, SheetItem } from "@/components/ds";
import type { PresenceChoice, Workspace } from "@/lib/data";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import { presenceLabelKey } from "../presence";
import { PRESENCE_CHOICES } from "../UserMenu";

export type SpaceSwitcherSheetProps = {
  open: boolean;
  workspaces: Workspace[];
  active: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
};

/** Every space, by name, with what is waiting in each, and the way to make another. */
export function SpaceSwitcherSheet({ open, workspaces, active, onSelect, onNew, onClose }: SpaceSwitcherSheetProps) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} label={t("shell.workspaces")} heading onClose={onClose}>
      <SheetGroup>
        {workspaces.map((w) => {
          const current = w.id === active;
          // Nothing for the space being read: its own counters are on screen already.
          const trailing = current ? (
            <Icon name="check" size={18} style={{ color: "var(--text-strong)" }} />
          ) : w.mentions > 0 ? (
            <Badge count={w.mentions} tone="mention" />
          ) : w.unread > 0 ? (
            <Badge dot tone="strong" />
          ) : null;
          return (
            <SheetItem
              key={w.id}
              leading={<Avatar name={w.name} src={w.iconUrl} kind="workspace" size={32} />}
              label={w.name}
              selected={current}
              trailing={trailing}
              onClick={() => {
                onClose();
                if (!current) onSelect(w.id);
              }}
            />
          );
        })}
      </SheetGroup>
      <SheetGroup>
        <SheetItem
          icon="plus"
          label={t("shell.newSpace")}
          onClick={() => {
            onClose();
            onNew();
          }}
        />
      </SheetGroup>
    </Sheet>
  );
}

export type YouSheetProps = {
  open: boolean;
  currentUser: string;
  presence: Presence;
  choice: PresenceChoice;
  onClose: () => void;
  onSetPresence: (choice: PresenceChoice) => void;
  onOpenProfile: () => void;
  onEditProfile: () => void;
  onOpenSettings: () => void;
  onOpenInstanceAdmin?: () => void;
  onHelp: () => void;
  onLogout: () => void;
};

/** The signed-in person's menu: availability, profile, preferences, help, and signing out. */
export function YouSheet({
  open,
  currentUser,
  presence,
  choice,
  onClose,
  onSetPresence,
  onOpenProfile,
  onEditProfile,
  onOpenSettings,
  onOpenInstanceAdmin,
  onHelp,
  onLogout,
}: YouSheetProps) {
  const { t } = useTranslation();
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet open={open} label={t("shell.myProfileAndStatus")} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 6px 14px" }}>
        <Avatar name={currentUser} src={getAvatar(currentUser)} size={48} presence={presence} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>{currentUser}</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t(presenceLabelKey(presence))}</div>
        </div>
      </div>
      <SheetGroup>
        {PRESENCE_CHOICES.map((c) => (
          <SheetItem
            key={c.key}
            leading={
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 12,
                  height: 12,
                  margin: "0 3px",
                  borderRadius: "var(--radius-full)",
                  background: `var(--presence-${c.dot})`,
                  border: c.dot === "offline" ? "1.5px solid var(--border-strong)" : undefined,
                }}
              />
            }
            label={t(c.labelKey)}
            selected={c.key === choice}
            trailing={c.key === choice ? <Icon name="check" size={18} /> : null}
            onClick={run(() => onSetPresence(c.key))}
          />
        ))}
      </SheetGroup>
      <SheetGroup>
        <SheetItem icon="smile" label={t("shell.viewProfile")} onClick={run(onOpenProfile)} />
        <SheetItem icon="square-pen" label={t("profile.edit")} onClick={run(onEditProfile)} />
        <SheetItem icon="settings" label={t("prefs.title")} onClick={run(onOpenSettings)} />
        {onOpenInstanceAdmin ? <SheetItem icon="shield" label={t("admin.screenTitle")} onClick={run(onOpenInstanceAdmin)} /> : null}
        <SheetItem icon="life-buoy" label={t("common.help")} onClick={run(onHelp)} />
      </SheetGroup>
      <SheetGroup>
        <SheetItem icon="log-out" label={t("shell.signOut")} danger onClick={run(onLogout)} />
      </SheetGroup>
    </Sheet>
  );
}
