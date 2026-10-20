/**
 * The space on screen. Every tab reads it; the space sheet changes it.
 *
 * One per signed-in instance (its scope, ADR 0007). The last one chosen there is remembered on the
 * phone with the instance (it names nothing sensitive), so the app reopens where it was left; the
 * first space is the default.
 */
import type { Workspace } from "@ruchoir/client";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { useApi } from "../api/useApi";
import { useLoad, type Loaded } from "../data/useLoad";
import { useReloadOn } from "../data/useReloadOn";
import { spaceStatus } from "./status";
import { useAccounts } from "../accounts/AccountsProvider";

type SpaceApi = {
  spaces: Loaded<Workspace[]>;
  status: ReturnType<typeof spaceStatus>;
  current: Workspace | null;
  select: (id: string) => void;
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
    (e) => e.type === "message" || e.type === "notification" || e.type === "readCursor" || e.type === "spaces",
    spaces.reload,
    1200,
  );

  const select = useCallback((id: string) => rememberSpace(instanceId, id), [instanceId, rememberSpace]);

  const list = spaces.data;
  const current = useMemo(() => list?.find((w) => w.id === chosen) ?? list?.[0] ?? null, [list, chosen]);
  const status = spaceStatus(list);
  const api = useMemo(() => ({ spaces, status, current, select }), [spaces, status, current, select]);
  return <SpaceContext.Provider value={api}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceApi {
  const api = useContext(SpaceContext);
  if (!api) throw new Error("useSpace outside SpaceProvider");
  return api;
}
