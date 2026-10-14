/**
 * The files waiting to go with the next message: each starts uploading the moment it is picked, shows
 * how far it is, can be removed or retried, and is sent with the text once it has arrived.
 *
 * A file larger than the instance accepts is refused before anything is sent, by name and with the
 * limit. A file from the space's files is attached as itself: it is already there.
 */
import {
  filePreviewUrl,
  fileDownloadUrl,
  isApiError,
  startAttachmentUpload,
  type InlineImage,
  type MessageAttachment,
  type SpaceFile,
} from "@ruchoir/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { uploadLimit } from "../api/limits";
import { useTranslation } from "../i18n";
import { useLocale } from "../i18n/useLocale";
import { splitBySize } from "../logic/attachments";
import { fileSize } from "../logic/format";
import { feel } from "../ui/haptics";

/** A file of the phone, as a picker hands it over. */
export type LocalFile = { uri: string; name: string; mime: string; size?: number; width?: number; height?: number };

export type PendingFile = {
  key: string;
  name: string;
  mime: string;
  size: number;
  /** The file on the phone, for a thumbnail and a retry; absent for a space file. */
  uri?: string;
  width?: number;
  height?: number;
  state: "uploading" | "ready" | "failed";
  /** Bytes sent so far. */
  sent: number;
  /** Why it failed, when the server said: larger than it accepts. */
  tooLarge?: boolean;
  attachment?: MessageAttachment;
};

let counter = 0;
const nextKey = () => `f${++counter}`;

export function useAttachments(conversationId: string) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const aborts = useRef(new Map<string, () => void>());

  const update = useCallback((key: string, change: Partial<PendingFile>) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...change } : f)));
  }, []);

  const upload = useCallback(
    (file: PendingFile) => {
      if (!file.uri) return;
      const request = startAttachmentUpload(conversationId, { uri: file.uri, name: file.name, type: file.mime }, (sent) =>
        update(file.key, { sent }),
      );
      aborts.current.set(file.key, request.abort);
      request.done
        .then(
          (attachment) => update(file.key, { state: "ready", sent: file.size, attachment }),
          (err: unknown) => {
            if (err instanceof Error && err.name === "AbortError") return;
            feel("failure");
            update(file.key, { state: "failed", tooLarge: isApiError(err, 413) });
          },
        )
        .finally(() => aborts.current.delete(file.key));
    },
    [conversationId, update],
  );

  const add = useCallback(
    async (picked: LocalFile[]) => {
      const limit = await uploadLimit();
      const { accepted: fitting, refused } = splitBySize(picked, limit);
      if (limit !== undefined && refused.length > 0) {
        Alert.alert(
          t("attach.tooLargeTitle", { count: refused.length }),
          t("attach.tooLargeText", { names: refused.map((f) => f.name).join(", "), limit: fileSize(limit, locale) }),
        );
      }
      const accepted = fitting.map(
          (f): PendingFile => ({
            key: nextKey(),
            name: f.name,
            mime: f.mime,
            size: f.size ?? 0,
            uri: f.uri,
            width: f.width,
            height: f.height,
            state: "uploading",
            sent: 0,
          }),
        );
      if (accepted.length === 0) return;
      setFiles((prev) => [...prev, ...accepted]);
      accepted.forEach(upload);
    },
    [locale, t, upload],
  );

  const addSpaceFile = useCallback((file: SpaceFile) => {
    const id = file.id;
    if (!id) return;
    setFiles((prev) =>
      prev.some((f) => f.attachment?.fileId === id)
        ? prev
        : [
            ...prev,
            {
              key: nextKey(),
              name: file.name,
              mime: file.mimeType ?? "application/octet-stream",
              size: file.sizeBytes,
              state: "ready",
              sent: file.sizeBytes,
              attachment: {
                fileId: id,
                name: file.name,
                sizeBytes: file.sizeBytes,
                kind: "file",
                url: fileDownloadUrl(id),
                previewUrl: filePreviewUrl(id),
              },
            },
          ],
    );
  }, []);

  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.();
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  const retry = useCallback(
    (key: string) => {
      const file = files.find((f) => f.key === key);
      if (!file || file.state !== "failed" || file.tooLarge) return;
      update(key, { state: "uploading", sent: 0 });
      upload(file);
    },
    [files, update, upload],
  );

  const clear = useCallback(() => setFiles([]), []);

  // Leaving the conversation stops what is still uploading: nothing would send it.
  useEffect(() => {
    const pending = aborts.current;
    return () => pending.forEach((abort) => abort());
  }, []);

  return useMemo(() => {
    const ready = files.filter((f) => f.state === "ready" && f.attachment);
    return {
      files,
      add,
      addSpaceFile,
      remove,
      retry,
      clear,
      uploading: files.some((f) => f.state === "uploading"),
      failed: files.some((f) => f.state === "failed"),
      /** What goes with the message: every arrived file, and the pictures among them. */
      attachments: ready.map((f) => f.attachment!),
      images: ready
        .filter((f) => f.mime.startsWith("image/"))
        .map(
          (f): InlineImage => ({
            fileId: f.attachment!.fileId,
            alt: f.name,
            width: f.width ?? 4,
            height: f.height ?? 3,
            src: f.attachment!.previewUrl,
          }),
        ),
    };
  }, [files, add, addSpaceFile, remove, retry, clear]);
}

export type Attachments = ReturnType<typeof useAttachments>;
