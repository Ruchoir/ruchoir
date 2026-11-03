"use client";

import { Fragment, useState } from "react";
import { Avatar, Button, Checkbox, Dialog, Icon, Input } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { addGroupMembers, refusalOf } from "@/lib/data/api";
import type { Role } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { key, useTranslation } from "@/lib/i18n";
import { formatList } from "@/lib/i18n/format";
import { foldName } from "../settings/groupsLogic.ts";
import type { Common } from "../settings/GroupDialogs";
import { refusalMessage, RoleChip } from "../settings/MemberAccess";
import { addBlockFor, guestCeilingApplies } from "./groupPanelLogic.ts";

/** Marks where the role chips go in a translated sentence. */
const ROLES_SLOT = "\u2063";

/** Put people in a group: members and guests of the space, those already in greyed, the roles they will get said first. */
export function AddPeopleDialog({
  spaceId,
  group,
  members,
  carries,
  viewerId,
  viewerIsOwner,
  onClose,
  onChanged,
  onNotify,
}: Common & { members: Member[]; carries: Role[]; viewerId: string; viewerIsOwner: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const needle = foldName(query.trim());
  const inGroup = new Set(group.memberIds);
  const people = members.filter((m) => !m.bot && foldName(m.name).includes(needle));
  const carriesRoles = carries.length > 0;
  const ctx = { carriesRoles, viewerId, viewerIsOwner };

  const add = async () => {
    setBusy(true);
    try {
      await addGroupMembers(spaceId, group.id, [...picked]);
      await onChanged();
      onNotify({ tone: "success", title: t("groups.membersAdded"), description: group.name });
      onClose();
    } catch (err) {
      onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry"), "members") });
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("groups.addTitle", { group: group.name })}
      subtitle={t("groups.addSub")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || picked.size === 0} onClick={() => void add()}>
            {picked.size === 0 ? t("groups.addConfirmNone") : t("groups.addConfirm", { count: picked.size })}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input size="sm" icon="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder={t("channel.searchPerson")} aria-label={t("channel.searchPerson")} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflow: "auto" }}>
          {people.map((m) => {
            const already = inGroup.has(m.userId);
            // Nobody gives themselves a role, through a group either: the row says why it is off.
            const blocked = !already && addBlockFor(ctx, m.userId) === "self_role";
            const off = already || blocked;
            return (
              <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 10, opacity: off ? 0.6 : 1 }}>
                <Checkbox
                  aria-label={m.name}
                  checked={already || (!blocked && picked.has(m.userId))}
                  disabled={off || busy}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.userId);
                      else next.delete(m.userId);
                      return next;
                    })
                  }
                />
                <Avatar name={m.name} src={m.avatarUrl ?? getAvatar(m.name)} size={28} />
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>{m.name}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    {already ? t("groups.alreadyIn") : blocked ? t("groups.noSelfJoin") : m.role === "guest" ? [t("role.guest"), m.title].filter(Boolean).join(" · ") : m.title}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
        {carries.length > 0 && picked.size > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "10px 12px",
              background: "var(--status-warning-bg)",
              border: "1px solid var(--status-warning-border)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              color: "var(--text-body)",
              lineHeight: "var(--leading-snug)",
            }}
          >
            <Icon name="alert-triangle" size={15} style={{ color: "var(--status-warning-fg)", marginTop: 1, flex: "none" }} />
            <span>
              {/* The sentence is translated whole, with the chips dropped where {{roles}} falls. */}
              {t(carries.length === 1 ? key("groups.addNoticeRole") : key("groups.addNoticeRoles"), {
                count: picked.size,
                names: formatList(members.filter((m) => picked.has(m.userId)).map((m) => m.name.split(" ")[0])),
                roles: ROLES_SLOT,
              })
                .split(ROLES_SLOT)
                .map((part, i, parts) => (
                  <Fragment key={i}>
                    {part}
                    {i < parts.length - 1 ? (
                      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, verticalAlign: "middle" }}>
                        {carries.map((r) => (
                          <RoleChip key={r.id} role={r} />
                        ))}
                      </span>
                    ) : null}
                  </Fragment>
                ))}
              {guestCeilingApplies(members, picked, carriesRoles) ? <div style={{ marginTop: 6 }}>{t("groups.guestCeiling")}</div> : null}
            </span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
