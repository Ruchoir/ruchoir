/**
 * Files of the phone attached to an event: each uploaded with its progress into the space's "Agenda"
 * folder (`eventAttachmentFolder`, the web's rule), then added to the draft. A file over the
 * instance's limit is refused before it goes, with its name; an event of a personal calendar
 * without a channel has no space for it, and says to choose a channel first.
 */
import { isApiError, type Calendar } from "@ruchoir/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { uploadLimit } from "../../../api/limits";
import { useApi } from "../../../api/useApi";
import type { LocalFile } from "../../../compose/useAttachments";
import { useTranslation } from "../../../i18n";
import { useLocale } from "../../../i18n/useLocale";
import { splitBySize } from "../../../logic/attachments";
import { phoneFilesNeedChannel } from "../../../logic/eventForm";
import { fileSize } from "../../../logic/format";
import { readDraft, updateDraft } from "./draftStore";

/** The most files an event carries (the API's limit). */
export const MAX_EVENT_FILES = 20;

export type PendingUpload = { key: string; file: LocalFile; sent: number; failed: boolean };

let uploads = 0;

export function useEventUploads(formKey: string, calendars: Calendar[] | undefined) {
  const api = useApi();
  const { eventAttachmentFolder, startFileUpload } = api;
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const aborts = useRef(new Map<string, () => void>());
  const update = useCallback((key: string, patch: Partial<PendingUpload>) => {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }, []);
  // Leaving the form stops what is still going.
  useEffect(() => {
    const running = aborts.current;
    return () => running.forEach((abort) => abort());
  }, []);

  const send = useCallback(
    async (item: PendingUpload) => {
      const draft = readDraft(formKey);
      if (!draft) return;
      update(item.key, { failed: false, sent: 0 });
      try {
        const folder = await eventAttachmentFolder(draft.calendarId, draft.channelId ?? undefined);
        const request = startFileUpload(folder.spaceId, { uri: item.file.uri, name: item.file.name, type: item.file.mime }, folder.folderId, (sent) =>
          update(item.key, { sent }),
        );
        aborts.current.set(item.key, request.abort);
        const stored = await request.done;
        const id = stored.id;
        if (id) {
          updateDraft(formKey, (d) =>
            d.files.some((f) => f.id === id) ? d : { ...d, files: [...d.files, { id, name: stored.name, size: stored.sizeBytes }], filesTouched: true },
          );
        }
        setPending((prev) => prev.filter((p) => p.key !== item.key));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        update(item.key, { failed: true });
        if (isApiError(err, 413)) Alert.alert(t("attach.tooLargeTitle", { count: 1 }), item.file.name);
      } finally {
        aborts.current.delete(item.key);
      }
    },
    [eventAttachmentFolder, formKey, startFileUpload, t, update],
  );

  const add = useCallback(
    async (picked: LocalFile[]) => {
      const draft = readDraft(formKey);
      if (!draft || picked.length === 0) return;
      const calendar = calendars?.find((cal) => cal.id === draft.calendarId);
      if (phoneFilesNeedChannel(calendar, draft.channelId)) {
        Alert.alert(t("eventForm.channelFirstTitle"), t("eventForm.channelFirstText"));
        return;
      }
      const limit = await uploadLimit(api);
      const { accepted, refused } = splitBySize(picked, limit);
      if (limit !== undefined && refused.length > 0) {
        Alert.alert(
          t("attach.tooLargeTitle", { count: refused.length }),
          t("attach.tooLargeText", { names: refused.map((f) => f.name).join(", "), limit: fileSize(limit, locale) }),
        );
      }
      const room = MAX_EVENT_FILES - draft.files.length - pending.length;
      const items = accepted.slice(0, Math.max(0, room)).map((file) => ({ key: `upload-${++uploads}`, file, sent: 0, failed: false }));
      if (items.length < accepted.length) Alert.alert(t("eventForm.filesMax"));
      if (items.length === 0) return;
      setPending((prev) => [...prev, ...items]);
      items.forEach((item) => void send(item));
    },
    [api, calendars, formKey, locale, pending.length, send, t],
  );

  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.();
    setPending((prev) => prev.filter((p) => p.key !== key));
  }, []);

  return { pending, add, retry: send, remove, uploading: pending.some((p) => !p.failed) };
}
