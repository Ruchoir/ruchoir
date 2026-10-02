"use client";

import { useState } from "react";
import { Button, Dialog, Field, Input } from "@/components/ds";
import { createBlankDocument } from "@/lib/data/api";
import type { BlankKind, SpaceFile } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";

/** "New document": a kind, a name, and the editor opens on the blank file. */
export function NewDocumentMenu({
  spaceId,
  folderId,
  onCreated,
  onNotify,
}: {
  spaceId: string;
  folderId?: string;
  onCreated: (file: SpaceFile) => void;
  onNotify: (toast: Toast) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BlankKind>("document");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const kinds: { value: BlankKind; label: string }[] = [
    { value: "document", label: t("office.kindDocument") },
    { value: "spreadsheet", label: t("office.kindSpreadsheet") },
    { value: "presentation", label: t("office.kindPresentation") },
  ];

  const create = () => {
    if (busy) return;
    setBusy(true);
    createBlankDocument(spaceId, kind, name.trim(), folderId)
      .then((file) => {
        setOpen(false);
        setName("");
        onNotify({ tone: "success", title: t("office.created"), description: file.name });
        onCreated(file);
      })
      .catch(() => onNotify({ tone: "danger", title: t("office.createFailed") }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Button size="sm" iconLeft="plus" onClick={() => setOpen(true)} style={{ flexShrink: 0 }}>
        {t("office.newDocument")}
      </Button>
      <Dialog
        open={open}
        title={t("office.newDocumentTitle")}
        closeLabel={t("common.close")}
        size="sm"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={create} disabled={busy}>
              {t("common.create")}
            </Button>
          </>
        }
      >
        <div role="radiogroup" aria-label={t("office.newDocumentTitle")} style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {kinds.map((k) => (
            <Button
              key={k.value}
              size="sm"
              role="radio"
              aria-checked={kind === k.value}
              variant={kind === k.value ? "primary" : "secondary"}
              iconLeft={k.value === "spreadsheet" ? "file-spreadsheet" : k.value === "presentation" ? "file" : "file-text"}
              onClick={() => setKind(k.value)}
            >
              {k.label}
            </Button>
          ))}
        </div>
        <Field label={t("files.name")} htmlFor="office-new-name">
          <Input
            id="office-new-name"
            autoFocus
            value={name}
            placeholder={t("office.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </Field>
      </Dialog>
    </>
  );
}
