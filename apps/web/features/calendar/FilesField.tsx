"use client";

import { type CSSProperties, useRef, useState } from "react";
import { Button, FileIcon, IconButton } from "@/components/ds";
import { uploadFile } from "@/lib/data/api";
import { eventAttachmentFolder, type EventFile } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";

/** The most files an event carries (the API's limit). */
export const MAX_EVENT_FILES = 20;

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 4px 4px 8px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-subtle)",
  background: "var(--surface-card)",
  fontSize: "var(--text-xs)",
  minWidth: 0,
};

/**
 * The files an event carries: a list, each taken off with its cross, then two ways to add more:
 * from a space's Drive (`onPickDrive` opens the picker), or from the device, which drops them into
 * the space's "Agenda" folder first. A personal event has no space of its own: its files go to the
 * space of its channel, so dropping one asks for a channel first.
 */
export function FilesField({
  calendarId,
  channelId,
  personal,
  value,
  onChange,
  onPickDrive,
  onFailed,
}: {
  calendarId: string;
  channelId: string | null;
  /** The calendar is the author's own (it has no space). */
  personal: boolean;
  value: EventFile[];
  onChange: (next: EventFile[]) => void;
  onPickDrive: () => void;
  onFailed: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const room = MAX_EVENT_FILES - value.length;
  const canDrop = !personal || Boolean(channelId);

  const drop = async (picked: File[]) => {
    if (picked.length === 0) return;
    setSending(true);
    try {
      const folder = await eventAttachmentFolder(calendarId, channelId ?? undefined);
      const added: EventFile[] = [];
      for (const file of picked.slice(0, room)) {
        const stored = await uploadFile(folder.spaceId, file, folder.folderId);
        if (stored.id) added.push({ id: stored.id, name: stored.name, size: stored.sizeBytes });
      }
      onChange([...value, ...added]);
    } catch {
      onFailed();
    } finally {
      setSending(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
      {value.length > 0 ? (
        <ul aria-label={t("calendar.files")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {value.map((f) => (
            <li key={f.id} style={row}>
              <FileIcon name={f.name} size={18} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-strong)" }}>{f.name}</span>
              <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flex: "none" }}>{formatBytes(f.size)}</span>
              <IconButton icon="x" size="sm" label={t("calendar.removeFile", { name: f.name })} onClick={() => onChange(value.filter((k) => k.id !== f.id))} />
            </li>
          ))}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <Button type="button" size="sm" variant="ghost" iconLeft="hard-drive" disabled={room <= 0 || sending} onClick={onPickDrive}>
          {t("calendar.fromDrive")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          iconLeft="upload"
          disabled={room <= 0 || sending || !canDrop}
          title={canDrop ? undefined : t("calendar.dropNeedsChannel")}
          onClick={() => input.current?.click()}
        >
          {sending ? t("common.sending") : t("calendar.fromDevice")}
        </Button>
        <input ref={input} type="file" multiple hidden onChange={(e) => void drop(Array.from(e.target.files ?? []))} />
      </div>
      {!canDrop ? <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>{t("calendar.dropNeedsChannel")}</span> : null}
    </div>
  );
}
