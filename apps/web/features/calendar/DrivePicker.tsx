"use client";

import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, FileIcon, Input, Select } from "@/components/ds";
import { getFilesView, searchFiles, type ViewEntry } from "@/lib/data/api";
import type { EventFile } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";
import { formatBytes } from "@/lib/i18n/format";

/**
 * Files of a space's Drive to attach to an event: the latest ones at first, or those whose name
 * matches what is typed, ticked one by one. Only files of the space's tree are offered (never a
 * folder, never a private conversation's attachment), which is what an event may carry.
 */
export function DrivePicker({
  spaces,
  spaceId,
  already,
  room,
  onPick,
  onClose,
}: {
  spaces: { id: string; name: string }[];
  /** The space offered first: the calendar's, or the linked channel's. */
  spaceId?: string;
  /** Files the event already carries, shown ticked and left alone. */
  already: string[];
  /** How many more the event may carry. */
  room: number;
  onPick: (files: EventFile[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [space, setSpace] = useState(spaceId ?? spaces[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ key: string; entries: ViewEntry[] } | null>(null);
  const [picked, setPicked] = useState<EventFile[]>([]);
  const key = `${space}/${query.trim()}`;

  useEffect(() => {
    if (!space) return;
    const abort = new AbortController();
    const words = query.trim();
    const wait = setTimeout(
      () => {
        (words ? searchFiles(space, words, abort.signal) : getFilesView(space, "recent", abort.signal))
          .then((entries) => setFound({ key: `${space}/${words}`, entries: entries.filter((e) => e.file.kind !== "folder" && e.file.id) }))
          .catch(() => {
            if (!abort.signal.aborted) setFound({ key: `${space}/${words}`, entries: [] });
          });
      },
      words ? 200 : 0,
    );
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [space, query]);

  const entries = found?.key === key ? found.entries : null;
  const toggle = (e: ViewEntry) => {
    const id = e.file.id ?? "";
    setPicked((list) =>
      list.some((f) => f.id === id) ? list.filter((f) => f.id !== id) : list.length < room ? [...list, { id, name: e.file.name, size: e.file.sizeBytes }] : list,
    );
  };

  return (
    <Dialog
      size="md"
      title={t("calendar.pickFiles")}
      onClose={onClose}
      closeLabel={t("common.back")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={picked.length === 0} onClick={() => onPick(picked)}>
            {t("calendar.attachCount", { count: picked.length })}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {spaces.length > 1 ? (
            <div style={{ flex: "1 1 160px", minWidth: 0 }}>
              <Select id="drive-space" size="sm" aria-label={t("calendar.driveOf")} value={space} onChange={(e) => setSpace(e.target.value)} options={spaces.map((s) => ({ value: s.id, label: s.name }))} style={{ width: "100%" }} />
            </div>
          ) : null}
          <div style={{ flex: "2 1 200px", minWidth: 0 }}>
            <Input id="drive-search" size="sm" type="search" icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("calendar.searchFiles")} aria-label={t("calendar.searchFiles")} style={{ width: "100%" }} />
          </div>
        </div>
        <span style={{ fontSize: "var(--text-2xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-muted)" }}>
          {query.trim() ? t("calendar.filesFound") : t("files.recent")}
        </span>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2, minHeight: 120 }}>
          {entries === null ? (
            <li style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", padding: 8 }}>{t("common.loading")}</li>
          ) : entries.length === 0 ? (
            <li style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", padding: 8 }}>{t("files.noFile")}</li>
          ) : (
            entries.map((e) => {
              const id = e.file.id ?? "";
              const there = already.includes(id);
              const on = there || picked.some((f) => f.id === id);
              return (
                <li
                  key={id}
                  // The whole line ticks the file; the box's own label already does, so it is left to it.
                  onClick={(ev) => {
                    if (there || (ev.target as HTMLElement).closest("label")) return;
                    toggle(e);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: "var(--radius-sm)", cursor: there ? "default" : "pointer", background: on ? "color-mix(in srgb, var(--acc) 22%, transparent)" : undefined }}
                >
                  <Checkbox checked={on} disabled={there || (!on && picked.length >= room)} onChange={() => toggle(e)} aria-label={e.file.name} />
                  <FileIcon name={e.file.name} mime={e.file.mimeType} size={22} />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.file.name}</span>
                    <span style={{ fontSize: "var(--text-2xs)", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[e.path.map((p) => p.name).join(" / ") || t("calendar.driveRoot"), formatBytes(e.file.sizeBytes)].join(" · ")}
                    </span>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </Dialog>
  );
}
