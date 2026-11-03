"use client";

import { type CSSProperties, useState } from "react";
import { Button, Card, Checkbox, Icon, Tag } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { refusalOf, setGroupRoles } from "@/lib/data/api";
import type { Group, Role } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { refusalMessage, RoleChip, roleLabel } from "./MemberAccess";

const st: Record<string, CSSProperties> = {
  intro: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--text-xs)", color: "var(--text-body)", margin: "16px 0 12px", lineHeight: "var(--leading-snug)" },
  row: { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px" },
  reason: { display: "flex", alignItems: "center", gap: 5, fontSize: "var(--text-2xs)", color: "var(--text-muted)", marginTop: 4 },
  savebar: {
    position: "sticky",
    bottom: 0,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 20,
    padding: "12px 14px",
    background: "var(--surface-raised)",
    border: "1.5px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-xs)",
    color: "var(--text-body)",
  },
};

/** The roles a group carries, ticked, with the locks a person's roles have: only under one's own role, never one's own. */
export function GroupRolesTab({
  spaceId,
  group,
  roles,
  me,
  frozen,
  onChanged,
  onNotify,
}: {
  spaceId: string;
  group: Group;
  roles: Role[];
  me?: Member;
  frozen: boolean;
  onChanged: () => Promise<void>;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const ranked = roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");
  const [draft, setDraft] = useState<Set<string>>(() => new Set(group.roleIds));
  const [busy, setBusy] = useState(false);
  const myTopRoleId = me?.roleIds?.[0];
  const editable = group.may.changeRoles && !frozen;
  const added = ranked.filter((r) => draft.has(r.id) && !group.roleIds.includes(r.id));
  const removed = ranked.filter((r) => !draft.has(r.id) && group.roleIds.includes(r.id));
  const changeCount = added.length + removed.length;
  const inGroup = !!me && group.memberIds.includes(me.userId);

  const save = async () => {
    setBusy(true);
    try {
      await setGroupRoles(spaceId, group.id, ranked.filter((r) => draft.has(r.id)).map((r) => r.id));
      await onChanged();
      onNotify({ tone: "success", title: t("groups.saved"), description: group.name });
    } catch (err) {
      onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={st.intro}>
        <Icon name="info" size={14} style={{ color: "var(--text-muted)", marginTop: 1 }} />
        <span>{frozen ? t("roles.frozenNote") : group.memberIds.length === 0 ? t("groups.rolesIntroEmpty") : t("groups.rolesIntro", { count: group.memberIds.length })}</span>
      </div>
      <Card>
        {ranked.map((role, i) => {
          const on = draft.has(role.id);
          const reason = !role.manageable ? (role.id === myTopRoleId ? t("roles.yourTopRole") : t("roles.aboveYou")) : t("roles.rightsCount", { count: role.permissions.length });
          const change = added.includes(role) ? t("roles.added") : removed.includes(role) ? t("roles.removed") : null;
          return (
            <div key={role.id} style={{ ...st.row, borderTop: i ? "1px solid var(--border-subtle)" : "none", background: change ? "var(--surface-sunken)" : undefined }}>
              <Checkbox
                aria-label={roleLabel(role, t)}
                checked={on}
                disabled={!editable || !role.manageable || busy}
                onChange={(e) =>
                  setDraft((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(role.id);
                    else next.delete(role.id);
                    return next;
                  })
                }
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <RoleChip role={role} />
                <div style={st.reason}>
                  {!role.manageable ? <Icon name="lock" size={12} /> : null}
                  {reason}
                </div>
              </span>
              {change ? <Tag tone="accent">{change}</Tag> : null}
            </div>
          );
        })}
      </Card>
      {editable && inGroup ? (
        <div style={{ ...st.reason, marginTop: 12 }}>
          <Icon name="info" size={13} />
          {t("groups.noSelfRole")}
        </div>
      ) : null}
      {changeCount > 0 ? (
        <div style={st.savebar}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <b>{t("roles.changes", { count: changeCount })}</b>
            {" : "}
            {[...added, ...removed].map((r) => roleLabel(r, t)).join(", ")}
          </span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(new Set(group.roleIds))}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("common.sending") : t("common.save")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
