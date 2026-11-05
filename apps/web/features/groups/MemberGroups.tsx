"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Button, Icon, IconButton, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { addGroupMembers, refusalOf, removeGroupMember } from "@/lib/data/api";
import type { Group, Role } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import { formatList } from "@/lib/i18n/format";
import { MenuPopover } from "../app/MenuPopover";
import type { Toast } from "../app/types";
import { groupsOf, sortGroups } from "../settings/groupsLogic.ts";
import { groupTagFor } from "../settings/guestLogic.ts";
import { refusalMessage, roleLabel } from "../settings/roleChips";
import { addBlockFor, removalOf } from "./groupPanelLogic.ts";

const s: Record<string, CSSProperties> = {
  section: { padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" },
  label: { fontFamily: "var(--label-font)", fontSize: "var(--text-2xs)", fontWeight: 500, color: "var(--text-muted)", marginBottom: 8 },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
};

/** A group as a pastille: the group icon, its name; it opens the group when `onOpen` is given. */
export function GroupChip({ group, onOpen, guestsOnly }: { group: Pick<Group, "id" | "name">; onOpen?: (groupId: string) => void; guestsOnly?: boolean }) {
  const inner = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Icon name="users" size={12} style={{ color: "var(--text-muted)" }} />
      {group.name}
    </span>
  );
  const chip = !onOpen ? (
    <Tag>{inner}</Tag>
  ) : (
    <button type="button" onClick={() => onOpen(group.id)} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", font: "inherit" }}>
      <Tag>{inner}</Tag>
    </button>
  );
  return guestsOnly ? (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {chip}
      <TagGuests />
    </span>
  ) : (
    chip
  );
}

function TagGuests() {
  const { t } = useTranslation();
  return <Tag tone="warning">{t("guests.sectionTitle")}</Tag>;
}

/** The "Groupes" section of a profile: the groups the person is in, openable when the caller says how. */
export function MemberGroupsSummary({ member, groups, onOpenGroup }: { member: Pick<Member, "userId">; groups: Group[]; onOpenGroup?: (groupId: string) => void }) {
  const { t } = useTranslation();
  const mine = groupsOf(member.userId, groups);
  if (mine.length === 0) return null;
  return (
    <div style={s.section}>
      <div style={s.label}>{t("groups.title")}</div>
      <div style={s.chips}>
        {mine.map((g) => (
          <GroupChip key={g.id} group={g} onOpen={onOpenGroup} />
        ))}
      </div>
    </div>
  );
}

/**
 * The person's groups, each with what it gives them and, where the caller may change that group's
 * members, the way out of it; and the way into another one. The API judges each change.
 */
export function MemberGroups({
  member,
  groups,
  roles,
  spaceId,
  viewerId,
  viewerIsOwner,
  onChanged,
  onNotify,
  people,
}: {
  /** The space's people, to tell a group of guests only (the tag); the groups list already holds who is in each. */
  people?: { userId: string; role: string }[];
  member: Member;
  groups: Group[];
  roles: Role[];
  spaceId: string;
  /** Who is looking: the removal rules depend on it. */
  viewerId: string;
  viewerIsOwner: boolean;
  onChanged?: () => Promise<void>;
  onNotify?: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const mine = groupsOf(member.userId, groups);
  const addable = sortGroups(groups.filter((g) => g.source !== "directory" && g.may.changeMembers && !g.may.addPeopleNeedsLicence && !g.memberIds.includes(member.userId) && addBlockFor({ carriesRoles: g.roleIds.length > 0, viewerId, viewerIsOwner }, member.userId) === null));
  if (mine.length === 0 && addable.length === 0) return null;
  const first = member.name.split(" ")[0];
  // The group panel's rule: the manager protection holds here too; leaving oneself is always possible.
  const canSortOut = (g: Group) => {
    const r = removalOf(g, viewerId, member.userId);
    return r.removable || r.reason === "self";
  };

  const run = async (write: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await write();
      await onChanged?.();
      onNotify?.({ tone: "success", title: done, description: member.name });
    } catch (err) {
      onNotify?.({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry"), "members") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.section}>
      <div style={s.label}>{t("groups.title")}</div>
      {mine.map((g, i) => {
        const carried = roles.filter((r) => g.roleIds.includes(r.id)).map((r) => roleLabel(r, t));
        return (
          <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
            <GroupChip group={g} guestsOnly={groupTagFor(g, people) === "guests"} />
            {carried.length > 0 ? (
              <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t("groups.carries", { roles: formatList(carried) })}</span>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {canSortOut(g) ? (
              <IconButton
                icon="user-minus"
                size="sm"
                disabled={busy}
                label={t("groups.leaveNamed", { name: first, group: g.name })}
                onClick={() => void run(() => removeGroupMember(spaceId, g.id, member.userId), t("groups.personRemoved"))}
              />
            ) : null}
          </div>
        );
      })}
      {addable.length > 0 ? (
        <div style={{ marginTop: mine.length > 0 ? 8 : 0 }}>
          <span ref={anchorRef} style={{ display: "inline-block" }}>
            <Button size="sm" variant="secondary" iconLeft="plus" disabled={busy} aria-haspopup="menu" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
              {t("groups.addToGroup")}
            </Button>
          </span>
          <MenuPopover
            anchorRef={anchorRef}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            placement="bottom"
            align="start"
            label={t("groups.addToGroup")}
            items={addable.map((g) => ({
              icon: "users",
              label: g.name,
              onClick: () => {
                setPickerOpen(false);
                void run(() => addGroupMembers(spaceId, g.id, [member.userId]), t("groups.membersAdded"));
              },
            }))}
          />
        </div>
      ) : null}
    </div>
  );
}
