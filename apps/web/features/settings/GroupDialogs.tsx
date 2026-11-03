"use client";

import { useState } from "react";
import { Button, Dialog, Field, Input } from "@/components/ds";
import { deleteGroup, refusalOf } from "@/lib/data/api";
import type { Group, Role } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { refusalMessage, roleLabel } from "./MemberAccess";

export type Common = { spaceId: string; group: Group; onChanged: () => Promise<void>; onNotify: (toast: Toast) => void };

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
          {/* Exact otherwise: a stray space around the name is forgiven, a different case is not. */}
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
