/**
 * The space on screen. Every tab reads it; the space sheet changes it.
 *
 * One per signed-in instance (its scope, ADR 0007). The last one chosen there is remembered on the
 * phone with the instance (it names nothing sensitive), so the app reopens where it was left; the
 * first space is the default.
 */
import type { Workspace } from "@ruchoir/client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

import { useApi } from "../api/useApi";
import { useLoad, type Loaded } from "../data/useLoad";
import { useReloadOn } from "../data/useReloadOn";
import { useRealtimeEvent } from "../realtime/RealtimeProvider";
import { useTranslation } from "../i18n";
import { endingCause, spaceEndings } from "../logic/guestNotices";
import { useToast } from "../ui/Toast";
import { spaceStatus } from "./status";
import { useAccounts } from "../accounts/AccountsProvider";

type SpaceApi = {
  spaces: Loaded<Workspace[]>;
  status: ReturnType<typeof spaceStatus>;
  current: Workspace | null;
  select: (id: string) => void;
  /** This phone is about to delete or leave a space: its disappearance from the list is no notice. */
  markGone: (id: string) => () => void;
};

const SpaceContext = createContext<SpaceApi | null>(null);

export function SpaceProvider({ instanceId, children }: { instanceId: string; children: ReactNode }) {
  const { getWorkspaces } = useApi();
  const { lastSpace, rememberSpace } = useAccounts();
  const spaces = useLoad("spaces", (signal) => getWorkspaces(signal));
  // The registry is the one memory of the space chosen, so one picked from another instance's
  // sheet (`switchTo`) and one picked here land the same way.
  const chosen = lastSpace(instanceId) ?? null;

  // Unread counts move with every message and notification.
  useReloadOn(
    (e) => e.type === "message" || e.type === "notification" || e.type === "readCursor" || e.type === "spaces" || e.type === "permissions",
    spaces.reload,
    1200,
  );

  const select = useCallback((id: string) => rememberSpace(instanceId, id), [instanceId, rememberSpace]);

  const list = spaces.data;

  // A space that left the list is said once, as on the web: a guest whose access ended is told so
  // (and that their messages stay), a removed member that they no longer belong to it.
  const { t } = useTranslation();
  const toast = useToast();
  const seen = useRef<Workspace[] | null>(null);
  const told = useRef(new Set<string>());
  // The spaces the server spoke about since the last diff, and those this phone removed itself.
  const caused = useRef(new Set<string>());
  const muted = useRef(new Set<string>());
  useRealtimeEvent((e) => {
    const id = endingCause(e);
    if (id) caused.current.add(id);
  });
  const markGone = useCallback((id: string) => {
    muted.current.add(id);
    // Undone when the call failed and the space is still ours.
    return () => void muted.current.delete(id);
  }, []);
  useEffect(() => {
    if (!list) return;
    const before = seen.current;
    seen.current = list;
    if (!before) return;
    for (const e of spaceEndings(before, list, told.current, { caused: caused.current, muted: muted.current })) {
      toast(t(e.title, { space: e.space }), "warning", e.body ? { body: t(e.body) } : undefined);
    }
    // Spoken about and gone are settled; one still in the list keeps its cause for a later read.
    const still = new Set(list.map((w) => w.id));
    for (const id of [...caused.current]) if (!still.has(id)) caused.current.delete(id);
  }, [list, t, toast]);
  const current = useMemo(() => list?.find((w) => w.id === chosen) ?? list?.[0] ?? null, [list, chosen]);
  const status = spaceStatus(list);
  const api = useMemo(() => ({ spaces, status, current, select, markGone }), [spaces, status, current, select, markGone]);
  return <SpaceContext.Provider value={api}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceApi {
  const api = useContext(SpaceContext);
  if (!api) throw new Error("useSpace outside SpaceProvider");
  return api;
}

/** The space on screen, or nothing outside a space (the sign-in flow's sheets read it too). */
export function useSpaceIfAny(): SpaceApi | null {
  return useContext(SpaceContext);
}
