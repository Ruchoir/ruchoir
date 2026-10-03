"use client";

import { useState } from "react";
import { Button, Dialog, Field, Icon, Input } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { createBlankDocument, createFolder } from "@/lib/data/api";
import type { BlankKind } from "@/lib/data/types";
import { useTranslation } from "@/lib/i18n";
import type { Toast } from "../app/types";
import { ActionMenu, type MenuEntry } from "./ActionMenu";
import type { MenuAt } from "./listTypes";

/**
 * "+ New": a folder, a blank document when the editor is on, or files from the device. A button
 * opening a menu on a desktop; a round button floating over the list on a phone, opening a sheet.
 */
export function NewMenu({
  compact,
  spaceId,
  folderId,
  office,
  newTab,
  onNotify,
  onUpload,
  onUploadFolder,
  onFolderCreated,
  onDocumentCreated,
}: {
  compact: boolean;
  spaceId: string;
  folderId?: string;
  /** Whether the editor is on, which is what blank documents need. */
  office: boolean;
  /** Whether a new document opens in a tab of its own (false: over the list). */
  newTab: boolean;
  onNotify: (toast: Toast) => void;
  onUpload: () => void;
  /** Pick a whole folder (absent where the device cannot: a phone). */
  onUploadFolder?: () => void;
  onFolderCreated: () => void;
  /** `tab` was opened on the click, for the document to open in (null: the browser refused it). */
  onDocumentCreated: (file: SpaceFile, tab: Window | null) => void;
}) {
  const { t } = useTranslation();
  const [at, setAt] = useState<MenuAt | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ kind: BlankKind; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const kinds: { kind: BlankKind; label: string; icon: "file-text" | "file-spreadsheet" | "file" }[] = [
    { kind: "document", label: t("office.kindDocument"), icon: "file-text" },
    { kind: "spreadsheet", label: t("office.kindSpreadsheet"), icon: "file-spreadsheet" },
    { kind: "presentation", label: t("office.kindPresentation"), icon: "file" },
  ];
  const entries: MenuEntry[] = [
    { label: t("files.newFolder"), icon: "folder-plus", onSelect: () => setFolderName(t("files.newFolder")) },
    ...(office
      ? ([{ separator: true }, ...kinds.map((k) => ({ label: k.label, icon: k.icon, onSelect: () => setDoc({ kind: k.kind, name: "" }) }))] as MenuEntry[])
      : []),
    { separator: true },
    { label: t("files.upload"), icon: "upload", onSelect: onUpload },
    ...(onUploadFolder ? [{ label: t("files.uploadFolder"), icon: "folder-open" as const, onSelect: onUploadFolder }] : []),
  ];

  const submitFolder = () => {
    const name = folderName?.trim();
    if (!name || busy) return;
    setBusy(true);
    createFolder(spaceId, name, folderId)
      .then(() => {
        setFolderName(null);
        onNotify({ tone: "success", title: t("files.folderCreated"), description: name });
        onFolderCreated();
      })
      .catch(() => onNotify({ tone: "danger", title: t("files.folderFailed") }))
      .finally(() => setBusy(false));
  };

  const submitDocument = () => {
    if (!doc || busy) return;
    setBusy(true);
    // The tab is opened now, on the click: once the document exists, the browser would take a new
    // tab for a pop-up and refuse it.
    const tab = newTab ? window.open("", "_blank") : null;
    createBlankDocument(spaceId, doc.kind, doc.name.trim(), folderId)
      .then((file) => {
        setDoc(null);
        // Opening over the list (a phone), the editor itself says it worked: a toast on top of it
        // was one more thing moving on a small screen while the document loads.
        if (newTab) onNotify({ tone: "success", title: t("office.created"), description: file.name });
        onDocumentCreated(file, tab);
      })
      .catch(() => {
        tab?.close();
        onNotify({ tone: "danger", title: t("office.createFailed") });
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      {compact ? (
        // The app's floating button (as on the conversations list), clear of the home indicator.
        <button
          type="button"
          className="wc-fab"
          aria-label={t("files.new")}
          aria-haspopup="menu"
          onClick={(e) => setAt({ anchor: e.currentTarget })}
          style={{ bottom: "calc(16px + env(safe-area-inset-bottom))" }}
        >
          <Icon name="plus" size={24} />
        </button>
      ) : (
        <Button size="sm" variant="primary" iconLeft="plus" aria-haspopup="menu" onClick={(e) => setAt({ anchor: e.currentTarget })} style={{ flexShrink: 0 }}>
          {t("files.new")}
        </Button>
      )}
      <ActionMenu open={at != null} at={at} title={t("files.new")} entries={entries} sheet={compact} onClose={() => setAt(null)} />

      <Dialog
        open={folderName != null}
        title={t("files.newFolder")}
        closeLabel={t("common.close")}
        size="sm"
        onClose={() => setFolderName(null)}
        footer={
          <>
            <Button onClick={() => setFolderName(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={submitFolder} disabled={busy || !folderName?.trim()}>
              {t("common.create")}
            </Button>
          </>
        }
      >
        <Field label={t("files.folderName")} htmlFor="files-new-folder">
          <Input
            id="files-new-folder"
            autoFocus
            // Pre-filled and selected: typing replaces it, Enter keeps it.
            onFocus={(e) => e.currentTarget.select()}
            value={folderName ?? ""}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitFolder();
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={doc != null}
        title={kinds.find((k) => k.kind === doc?.kind)?.label}
        closeLabel={t("common.close")}
        size="sm"
        onClose={() => setDoc(null)}
        footer={
          <>
            <Button onClick={() => setDoc(null)}>{t("common.cancel")}</Button>
            <Button variant="primary" onClick={submitDocument} disabled={busy}>
              {t("common.create")}
            </Button>
          </>
        }
      >
        <Field label={t("files.name")} htmlFor="files-new-document">
          <Input
            id="files-new-document"
            autoFocus
            value={doc?.name ?? ""}
            placeholder={t("office.namePlaceholder")}
            onChange={(e) => setDoc((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitDocument();
            }}
          />
        </Field>
      </Dialog>
    </>
  );
}
