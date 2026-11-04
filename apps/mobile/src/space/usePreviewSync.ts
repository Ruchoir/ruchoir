/**
 * What keeps the phone honest while a space is looked at as a role (`space.preview`):
 *
 * - the instance's client sends no background write (read cursors, "is writing", notification reads,
 *   the editor's heartbeat, the push token): `setPreviewing`;
 * - a write the server still refuses says the shared sentence, once per refused request;
 * - the server ends a preview after a while without activity, and the socket of a previewing session
 *   is refused, so nothing tells the phone: it asks again every minute and when it comes back to the
 *   front, and says so when the space comes back as the person's own.
 *
 * Returns the key the navigation takes (the role looked at, or the person's own): it starts again when
 * the preview starts or ends, since everything on screen was read as the other role.
 */
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useAccounts } from "../accounts/AccountsProvider";
import { useTranslation, type DictKey } from "../i18n";
import { previewEnded, refusedSentence } from "../logic/preview";
import { useToast } from "../ui/Toast";
import { useSpace } from "./SpaceProvider";

const ASK_EVERY_MS = 60_000;

export function usePreviewSync(instanceId: string): { quit: (quitting: boolean) => void; navigationKey: string } {
  const { current, spaces } = useSpace();
  const { setPreviewing, onPreviewReadOnly } = useAccounts();
  const { t } = useTranslation();
  const toast = useToast();
  const roleId = current?.preview?.roleId;
  const reload = spaces.reload;
  const quitting = useRef(false);
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    setPreviewing(instanceId, roleId !== undefined);
    return () => setPreviewing(instanceId, false);
  }, [instanceId, roleId, setPreviewing]);

  useEffect(
    () => onPreviewReadOnly(instanceId, (request) => toast(String(t(refusedSentence(request) as DictKey)), "failure", { preview: true })),
    [instanceId, onPreviewReadOnly, toast, t],
  );

  // The idle end, or an end from another device: ask again while a preview is shown.
  useEffect(() => {
    if (!roleId) return;
    const timer = setInterval(reload, ASK_EVERY_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") reload();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [roleId, reload]);

  useEffect(() => {
    const before = seen.current;
    seen.current = roleId;
    if (!before || !current) return;
    if (previewEnded(before, current) && !quitting.current) toast(t("preview.ended"));
    if (roleId === undefined) quitting.current = false;
  }, [roleId, current, toast, t]);

  return {
    quit: (on: boolean) => {
      quitting.current = on;
    },
    navigationKey: roleId ?? "own",
  };
}
