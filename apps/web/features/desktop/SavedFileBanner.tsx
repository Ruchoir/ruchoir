"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, isApiError, type RuchoirClient } from "@ruchoir/client";
import { Button, Dialog, Icon } from "@/components/ds";
import { fileDismiss, fileKeepCopy, fileSendVersion, onFileSaved, onFilesForgotten, onInstancesChanged } from "@/lib/desktop/bridge";
import { instanceBase } from "@/lib/desktop/runtime";
import { useTranslation } from "@/lib/i18n";
import { choiceFor, codeOfStatus, errorText as errorWords, fileKey, pushSaved, VISIBLE_SAVED, type SavedFile } from "./savedFile";

/** Where a banner stands: answered ("sending", "asking" in the dialog), done, or failed with the core's code. */
type Phase = { kind: "sending" } | { kind: "asking" } | { kind: "sent" } | { kind: "error"; code: string };

/** How long "Version sent" stays before the banner leaves by itself. */
const SENT_MS = 4000;

/**
 * "The file you opened was saved: send it as a new version?", on any screen. The core tells
 * `file:saved` when an opened copy changes (and again when the system notification is clicked, which
 * only shows the window). One banner per file, the newest first, three at most in view.
 *
 * Before sending, the file's versions are read: if someone added one since the file was opened, the
 * person is asked, rather than silently putting this copy on top of theirs.
 */
export function SavedFileBanner() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<SavedFile[]>([]);
  // The list as last rendered, for a listener that outlives a render.
  const savedRef = useRef<SavedFile[]>([]);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  // A client per instance: the saved file may belong to one the interface is not showing.
  const clients = useRef(new Map<string, RuchoirClient>());
  const timers = useRef(new Map<string, number>());

  const clientOf = (instance: string) => {
    let client = clients.current.get(instance);
    if (!client) {
      client = createClient({ baseUrl: instanceBase(instance) });
      clients.current.set(instance, client);
    }
    return client;
  };

  const setPhase = useCallback((key: string, phase: Phase | null) => {
    setPhases((prev) => {
      const next = { ...prev };
      if (phase) next[key] = phase;
      else delete next[key];
      return next;
    });
  }, []);

  const drop = useCallback(
    (key: string) => {
      window.clearTimeout(timers.current.get(key));
      timers.current.delete(key);
      setSaved((prev) => prev.filter((s) => fileKey(s) !== key));
      setPhase(key, null);
    },
    [setPhase],
  );

  // A client for an instance that was removed or signed out is let go with it.
  useEffect(() => {
    const stop = onInstancesChanged((views) => {
      const live = new Set(views.filter((v) => v.state === "signed_in" && v.id).map((v) => v.id));
      for (const id of [...clients.current.keys()]) if (!live.has(id)) clients.current.delete(id);
    });
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  // A deliberate sign-out or a removal deletes the instance's copies: their banners go too. An
  // expired session keeps them (they say "signed out" and work after the next sign-in).
  useEffect(() => {
    const stop = onFilesForgotten((instance) => {
      clients.current.delete(instance);
      for (const key of [...savedRef.current].filter((s) => s.instance === instance).map(fileKey)) drop(key);
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [drop]);

  useEffect(() => {
    const stop = onFileSaved((event) => {
      const key = fileKey(event);
      // A newer save starts the question again, whatever the older banner was doing.
      window.clearTimeout(timers.current.get(key));
      timers.current.delete(key);
      setPhase(key, null);
      setSaved((prev) => pushSaved(prev, event));
    });
    const pending = timers.current;
    return () => {
      void stop.then((unlisten) => unlisten());
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, [setPhase]);

  const send = async (s: SavedFile) => {
    const key = fileKey(s);
    setPhase(key, { kind: "sending" });
    try {
      await fileSendVersion(s.instance, s.file_id);
      setPhase(key, { kind: "sent" });
      timers.current.set(key, window.setTimeout(() => drop(key), SENT_MS));
    } catch (code) {
      // "not_watched" (the core let go of the copy, say after a sign-out) gets its words like the rest.
      setPhase(key, { kind: "error", code: typeof code === "string" ? code : "failed" });
    }
  };

  const check = async (s: SavedFile) => {
    const key = fileKey(s);
    setPhase(key, { kind: "sending" });
    let choice: "send" | "ask";
    try {
      choice = choiceFor(await clientOf(s.instance).getVersions(s.file_id), s.base_version);
    } catch (error) {
      setPhase(key, { kind: "error", code: codeOfStatus(isApiError(error) ? error.status : undefined) });
      return;
    }
    if (choice === "send") await send(s);
    else setPhase(key, { kind: "asking" });
  };

  const ignore = (s: SavedFile) => {
    void fileDismiss(s.instance, s.file_id).catch(() => {});
    drop(fileKey(s));
  };

  const keepCopy = async (s: SavedFile) => {
    const key = fileKey(s);
    try {
      if (await fileKeepCopy(s.instance, s.file_id)) ignore(s);
      else setPhase(key, { kind: "asking" });
    } catch (code) {
      setPhase(key, { kind: "error", code: typeof code === "string" ? code : "failed" });
    }
  };

  const visible = saved.slice(0, VISIBLE_SAVED);
  const asking = visible.find((s) => phases[fileKey(s)]?.kind === "asking") ?? null;

  const errorText = (code: string) => errorWords(code, t);

  if (visible.length === 0) return null;
  return (
    <>
      <div className="wc-saved" role="region" aria-label={t("desktop.files.saved.region")}>
        {visible.map((s) => {
          const key = fileKey(s);
          const phase = phases[key];
          const busy = phase?.kind === "sending";
          return (
            <div className="wc-saved__item" key={key} role="status">
              <Icon name="file-text" size={18} className="wc-saved__icon" />
              <div className="wc-saved__text">
                {phase?.kind === "sent" ? (
                  <span>{t("desktop.files.saved.sent")}</span>
                ) : (
                  <span>{t("desktop.files.saved.body", { name: s.name })}</span>
                )}
                {phase?.kind === "error" ? <span className="wc-saved__error">{errorText(phase.code)}</span> : null}
              </div>
              {phase?.kind === "sent" ? null : (
                <div className="wc-saved__actions">
                  <Button size="sm" variant="primary" disabled={busy || phase?.kind === "asking"} onClick={() => void check(s)}>
                    {t("composer.send")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => ignore(s)}>
                    {t("files.conflictSkip")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {asking ? (
        <Dialog
          title={t("desktop.files.saved.conflictTitle")}
          onClose={() => setPhase(fileKey(asking), null)}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button variant="ghost" onClick={() => void keepCopy(asking)}>
                {t("desktop.files.saved.keepCopy")}
              </Button>
              <Button variant="primary" onClick={() => void send(asking)}>
                {t("desktop.files.saved.sendAnyway")}
              </Button>
            </>
          }
        >
          <p>{t("desktop.files.saved.conflictBody", { name: asking.name })}</p>
        </Dialog>
      ) : null}
    </>
  );
}
