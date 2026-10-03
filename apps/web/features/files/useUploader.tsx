"use client";

import { useRef, useState } from "react";
import { Button, Checkbox, Dialog } from "@/components/ds";
import type { SpaceFile } from "@/lib/data";
import { createFolder, getFolder } from "@/lib/data/api";
import { useTranslation } from "@/lib/i18n";
import { enqueue, reject, type UploadInput } from "@/lib/uploads";
import type { Toast } from "../app/types";
import type { Dropped } from "./dropFiles";
import { canManage } from "./model";
import { folderPaths, isTaken, splitPath, tooLarge, uniqueName } from "./uploadPlan";

type Choice = "replace" | "keepBoth" | "skip";

type Question = {
  name: string;
  folder: string;
  /** How many duplicates come after this one ("do the same for the others"). */
  others: number;
  canReplace: boolean;
  resolve: (answer: { choice: Choice; forAll: boolean } | null) => void;
};

/**
 * From "these files, into this folder" to the upload queue: what is too large is turned down at
 * once; the folders a dropped tree needs are made (one already there under the same name is used, as
 * OneDrive and Nextcloud do, rather than doubled); a name already taken asks "replace, keep both or
 * skip"; then everything is queued.
 */
export function useUploader({
  spaceId,
  maxBytes,
  currentUserId,
  spaceRole,
  onNotify,
  onFolderCreated,
}: {
  spaceId: string;
  maxBytes?: number;
  currentUserId?: string;
  spaceRole?: string;
  onNotify: (toast: Toast) => void;
  /** A folder made for the upload, to show in the list if it belongs there. */
  onFolderCreated: (folder: SpaceFile) => void;
}) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState<Question | null>(null);
  const [forAll, setForAll] = useState(false);
  const busy = useRef(false);

  const ask = (q: Omit<Question, "resolve">) =>
    new Promise<{ choice: Choice; forAll: boolean } | null>((resolve) => {
      setForAll(false);
      setQuestion({ ...q, resolve });
    });
  const answer = (value: { choice: Choice; forAll: boolean } | null) => {
    question?.resolve(value);
    setQuestion(null);
  };

  const send = async (dropped: Dropped, target: { folderId?: string; name: string }) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const input = (file: File, name: string, folderId?: string): UploadInput => ({ file, name, spaceId, folderId });

      const fits = dropped.files.filter((f) => {
        if (!tooLarge(f.file.size, maxBytes)) return true;
        reject(input(f.file, f.file.name, target.folderId), "tooLarge");
        return false;
      });

      // What each folder holds, asked once; a folder made just now is known to be empty.
      const listings = new Map<string, SpaceFile[]>();
      const listing = async (folderId: string | undefined) => {
        const key = folderId ?? "";
        if (!listings.has(key)) listings.set(key, (await getFolder(spaceId, folderId)).entries);
        return listings.get(key)!;
      };

      // The tree: each folder path resolved to an id, parents first. `null`: it could not be made.
      const dirIds = new Map<string, string | undefined | null>([["", target.folderId]]);
      const dirs = folderPaths([...fits.map((f) => f.path), ...dropped.emptyDirs.map((d) => `${d}/.`)]);
      for (const dir of dirs) {
        const { dirs: parents, name } = splitPath(dir);
        const parentId = dirIds.get(parents.join("/"));
        if (parentId === null) {
          dirIds.set(dir, null);
          continue;
        }
        try {
          const siblings = await listing(parentId);
          const same = siblings.find((f) => f.kind === "folder" && isTaken(name, [f.name]));
          if (same?.id) {
            dirIds.set(dir, same.id);
            continue;
          }
          const made = await createFolder(spaceId, name, parentId);
          siblings.push(made);
          if (made.id) listings.set(made.id, []);
          dirIds.set(dir, made.id);
          onFolderCreated(made);
        } catch {
          dirIds.set(dir, null);
          onNotify({ tone: "danger", title: t("files.folderFailed"), description: name });
        }
      }

      // Each file at its destination, with what it would collide with there.
      const planned: { file: File; name: string; folderId?: string; folderName: string; clash?: SpaceFile }[] = [];
      for (const f of fits) {
        const { dirs: parents, name } = splitPath(f.path);
        const folderId = dirIds.get(parents.join("/"));
        if (folderId === null) {
          reject(input(f.file, name, target.folderId), "server");
          continue;
        }
        const siblings = await listing(folderId).catch(() => [] as SpaceFile[]);
        const clash = siblings.find((s) => isTaken(name, [s.name]));
        planned.push({ file: f.file, name, folderId, folderName: parents.length > 0 ? parents[parents.length - 1] : target.name, clash });
      }

      // What collides with nothing goes now; the duplicates wait for an answer.
      enqueue(planned.filter((p) => !p.clash).map((p) => input(p.file, p.name, p.folderId)));
      const clashes = planned.filter((p) => p.clash);
      // Names given in this batch count as taken for the next "keep both".
      const given = new Map<string, string[]>();
      let standing: Choice | null = null;
      for (let i = 0; i < clashes.length; i++) {
        const p = clashes[i];
        const existing = p.clash!;
        const canReplace = existing.kind !== "folder" && !!existing.id && canManage(existing, currentUserId, spaceRole);
        let choice = standing;
        if (!choice) {
          const reply = await ask({ name: p.name, folder: p.folderName, others: clashes.length - i - 1, canReplace });
          if (!reply) break;
          choice = reply.choice;
          if (reply.forAll) standing = reply.choice;
        }
        if (choice === "replace" && !canReplace) choice = "keepBoth";
        if (choice === "skip") continue;
        if (choice === "replace") {
          enqueue([{ ...input(p.file, existing.name, p.folderId), replaceFileId: existing.id }]);
        } else {
          const key = p.folderId ?? "";
          const taken = [...(listings.get(key) ?? []).map((s) => s.name), ...(given.get(key) ?? [])];
          const name = uniqueName(p.name, taken);
          given.set(key, [...(given.get(key) ?? []), name]);
          enqueue([input(p.file, name, p.folderId)]);
        }
      }
    } catch {
      onNotify({ tone: "danger", title: t("files.uploadFailed") });
    } finally {
      busy.current = false;
    }
  };

  const dialog = (
    <Dialog
      open={question != null}
      title={question ? t("files.conflictTitle", { name: question.name }) : undefined}
      closeLabel={t("common.close")}
      // Three answers side by side need the room.
      size="md"
      onClose={() => answer(null)}
      footer={
        question ? (
          <>
            <Button onClick={() => answer({ choice: "skip", forAll })}>{t("files.conflictSkip")}</Button>
            <div style={{ flex: 1 }} />
            <Button onClick={() => answer({ choice: "keepBoth", forAll })}>{t("files.conflictKeepBoth")}</Button>
            {question.canReplace ? (
              <Button variant="primary" onClick={() => answer({ choice: "replace", forAll })}>
                {t("files.conflictReplace")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {question ? (
        <>
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
            {t("files.conflictBody", { folder: question.folder })}
            {question.canReplace ? ` ${t("files.conflictReplaceHint")}` : ""}
          </p>
          {question.others > 0 ? (
            <div style={{ marginTop: 14 }}>
              <Checkbox checked={forAll} onChange={(e) => setForAll(e.target.checked)} label={t("files.conflictForAll", { count: question.others })} />
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );

  return { send, dialog };
}
