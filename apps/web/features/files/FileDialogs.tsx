"use client";

import { useState } from "react";
import { Button, Dialog, Field, Input } from "@/components/ds";
import { useTranslation } from "@/lib/i18n";
import type { Item } from "./listTypes";

/** Renaming one entry. The base of the name is selected, not its extension, as a file manager does. */
export function RenameDialog({ item, onClose, onRename }: { item: Item | null; onClose: () => void; onRename: (name: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [openedFor, setOpenedFor] = useState<Item | null>(null);
  if (item && openedFor !== item) {
    setOpenedFor(item);
    setName(item.file.name);
  }
  const submit = () => {
    const next = name.trim();
    if (!next) return;
    onRename(next);
  };
  return (
    <Dialog
      open={item != null}
      title={t("files.rename")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim()}>
            {t("files.rename")}
          </Button>
        </>
      }
    >
      <Field label={t("files.name")} htmlFor="files-rename">
        <Input
          id="files-rename"
          autoFocus
          value={name}
          onFocus={(e) => {
            const dot = item && !item.entry.isFolder ? e.currentTarget.value.lastIndexOf(".") : -1;
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
          }}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
    </Dialog>
  );
}

/**
 * Confirming a removal. Entries the person may not remove are named before anything happens, and
 * left out, rather than refused one by one afterwards.
 */
export function DeleteDialog({
  items,
  skipped,
  onClose,
  onConfirm,
}: {
  /** What will be removed. Empty when the dialog is closed. */
  items: Item[];
  /** How many selected entries are left out for want of the right to remove them. */
  skipped: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const folder = items.some((i) => i.entry.isFolder);
  return (
    <Dialog
      open={items.length > 0}
      title={items.length > 1 ? t("files.deleteManyTitle", { count: items.length }) : t("files.deleteTitle")}
      closeLabel={t("common.close")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" iconLeft="trash-2" onClick={onConfirm}>
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
        {items.length === 1 ? t("files.deleteOneBody", { name: items[0].file.name }) : t("files.deleteBody")}
        {folder ? ` ${t("files.folderTakesAll")}` : ""}
      </p>
      {skipped > 0 ? (
        <p style={{ margin: "10px 0 0", fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: "var(--leading-normal)" }}>
          {t("files.skippedNotYours", { count: skipped })}
        </p>
      ) : null}
    </Dialog>
  );
}
