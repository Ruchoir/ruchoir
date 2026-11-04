/**
 * What keeps the phone honest while a space is looked at as a role (`space.preview`):
 *
 * - the instance's client sends no background write (read cursors, "is writing", notification reads,
 *   the editor's heartbeat, the push token): `setPreviewing`;
 * - a write the server still refuses says the shared sentence, once per refused request;
 * - the server ends a preview after a while without activity, and the socket of a previewing session
 *   is refused, so nothing tells the phone. The phone keeps its own idle count (the last touch,
 *   `activity.ts`) and quits the preview itself when it runs out; polling the spaces would be
 *   activity for the server and keep the preview alive for ever. It asks the server only when it
 *   comes back to the front (the end may have happened meanwhile, or on another device);
 * - a preview belongs to the session, not to a space: when the space on screen changes (or the
 *   instance does, which unmounts this), the preview of the previous one is quit first, and no
 *   "preview ended" is said for it.
 *
 * Returns the key the navigation takes (the role looked at, or the person's own): it starts again when
 * the preview starts or ends, since everything on screen was read as the other role.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useAccounts } from "../accounts/AccountsProvider";
import { useApi } from "../api/useApi";
import { useTranslation, type DictKey } from "../i18n";
import { idleExpired, previewTransition, refusedBody, refusedSentence } from "../logic/preview";
import { useToast } from "../ui/Toast";
import { lastTouch, noteTouch } from "./activity";
import { useSpace } from "./SpaceProvider";

/** How often the idle count is looked at while a preview is shown. */
const LOOK_EVERY_MS = 15_000;

export function usePreviewSync(instanceId: string): {
  quit: (quitting: boolean) => void;
  navigationKey: string;
  onTouchCapture: typeof noteTouch;
} {
  const { current, spaces } = useSpace();
  const api = useApi();
  const { quitPreview } = api;
  const { setPreviewing, onPreviewReadOnly } = useAccounts();
  const { t } = useTranslation();
  const toast = useToast();
  const spaceId = current?.id;
  const roleId = current?.preview?.roleId;
  const idleSeconds = current?.preview?.idleSeconds;
  const reload = spaces.reload;
  const quitting = useRef(false);
  const ending = useRef(false);
  const seen = useRef<{ spaceId: string; roleId: string | undefined } | undefined>(undefined);

  // Leaving the instance (another one is shown) with a preview on: the session's preview is quit,
  // while the flag below still says it is on (cleanups run in order).
  useEffect(
    () => () => {
      const last = seen.current;
      if (last?.roleId && api.options().previewActive?.()) void quitPreview(last.spaceId).catch(() => {});
    },
    // The latest client is read when the scope goes: nothing to re-run for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    setPreviewing(instanceId, roleId !== undefined, spaceId);
    return () => setPreviewing(instanceId, false);
  }, [instanceId, roleId, spaceId, setPreviewing]);

  useEffect(
    () =>
      onPreviewReadOnly(instanceId, (request) =>
        toast(String(t(refusedSentence(request) as DictKey)), "failure", { preview: true, body: String(t(refusedBody(request) as DictKey)) }),
      ),
    [instanceId, onPreviewReadOnly, toast, t],
  );

  // The idle end: counted here from the last touch. The server's own timer is not asked (a poll is
  // activity); back in front, it is, since the end may have happened meanwhile.
  useEffect(() => {
    if (!roleId || !spaceId) return;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active" || ending.current) return;
      if (!idleExpired(lastTouch(), Date.now(), idleSeconds)) return;
      ending.current = true;
      quitPreview(spaceId).then(
        () => {
          quitting.current = true;
          toast(t("preview.ended"));
        },
        () => {},
      ).finally(() => {
        ending.current = false;
        reload();
      });
    }, LOOK_EVERY_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") reload();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [roleId, spaceId, idleSeconds, reload, quitPreview, toast, t]);

  useEffect(() => {
    if (!current) return;
    const { quitSpaceId, ended } = previewTransition(seen.current, current);
    seen.current = { spaceId: current.id, roleId };
    if (quitSpaceId) void quitPreview(quitSpaceId).catch(() => {}).finally(reload);
    if (ended && !quitting.current) toast(t("preview.ended"));
    if (roleId === undefined) quitting.current = false;
  }, [roleId, current, quitPreview, reload, toast, t]);

  return {
    quit: (on: boolean) => {
      quitting.current = on;
    },
    navigationKey: roleId ?? "own",
    onTouchCapture: noteTouch,
  };
}
