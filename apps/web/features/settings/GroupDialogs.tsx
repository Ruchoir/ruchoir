"use client";

import { useState } from "react";
import { Avatar, Button, Checkbox, Dialog, Field, Input } from "@/components/ds";
import type { Member } from "@/lib/data/api";
import { addGroupMembers, deleteGroup, refusalOf } from "@/lib/data/api";
import type { Group, Role } from "@/lib/data/types";
import { getAvatar } from "@/lib/data";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { foldName } from "./groupsLogic.ts";
import { refusalMessage, roleLabel } from "./MemberAccess";

type Common = { spaceId: string; group: Group; onChanged: () => Promise<void>; onNotify: (toast: Toast) => void };

/** Put people in a group: members and guests of the space, those already in greyed, the roles they will get said first. */
export function AddPeopleDialog({
  spaceId,
  group,
  members,
  carries,
  onClose,
  onChanged,
  onNotify,
}: Common & { members: Member[]; carries: Role[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const needle = foldName(query.trim());
  const inGroup = new Set(group.memberIds);
  const people = members.filter((m) => !m.bot && foldName(m.name).includes(needle));

  const add = async () => {
    setBusy(true);
    try {
      await addGroupMembers(spaceId, group.id, [...picked]);
      await onChanged();
      onNotify({ tone: "success", title: t("groups.membersAdded"), description: group.name });
      onClose();
    } catch (err) {
      onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
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
            {t("groups.addConfirm", { count: picked.size })}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input size="sm" icon="search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} placeholder={t("channel.searchPerson")} aria-label={t("channel.searchPerson")} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 320, overflow: "auto" }}>
          {people.map((m) => {
            const already = inGroup.has(m.userId);
            return (
              <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 10, opacity: already ? 0.6 : 1 }}>
                <Checkbox
                  aria-label={m.name}
                  checked={already || picked.has(m.userId)}
                  disabled={already || busy}
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
                    {already ? t("groups.alreadyIn") : m.role === "guest" ? [t("role.guest"), m.title].filter(Boolean).join(" · ") : m.title}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
        {carries.length > 0 && picked.size > 0 ? (
          <div
            style={{
              padding: "10px 12px",
              background: "var(--warning-soft, var(--surface-sunken))",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              fontSize: "var(--text-xs)",
              color: "var(--text-body)",
              lineHeight: "var(--leading-snug)",
            }}
          >
            {t("groups.addNotice", { roles: carries.map((r) => roleLabel(r, t)).join(", ") })}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Delete a group, confirmed by typing its name, saying what its members lose. */
export function DeleteGroupDialog({
  spaceId,
  group,
  carries,
  onClose,
  onChanged,
  onNotify,
  onDeleted,
}: Common & { carries: Role[]; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await deleteGroup(spaceId, group.id);
      onClose();
      await onChanged();
      onNotify({ tone: "success", title: t("groups.deleted"), description: group.name });
      onDeleted();
    } catch (err) {
      onClose();
      onNotify({ tone: "danger", title: t("roles.saveFailed"), description: refusalMessage(refusalOf(err), t, t("space.retry")) });
    }
  };

  return (
    <Dialog
      open
      title={t("groups.deleteTitle", { group: group.name })}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" iconLeft="trash-2" disabled={busy || typed.trim() !== group.name} onClick={() => void remove()}>
            {t("groups.delete")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-snug)", margin: 0 }}>
          {carries.length > 0
            ? t("groups.deleteRoles", { roles: carries.map((r) => roleLabel(r, t)).join(", "), group: group.name })
            : t("groups.deletePlain", { group: group.name })}
        </p>
        <Field label={t("groups.deleteConfirm")} htmlFor="delete-group-name">
          <Input id="delete-group-name" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
