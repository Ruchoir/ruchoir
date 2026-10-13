/**
 * The space on screen. Every tab reads it; the space sheet changes it.
 *
 * The last one chosen is remembered on the phone (it names nothing sensitive), so the app reopens
 * where it was left; the first space is the default.
 */
import { getWorkspaces, type Workspace } from "@ruchoir/client";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLoad, type Loaded } from "../data/useLoad";
import { useReloadOn } from "../data/useReloadOn";
import { spaceStatus } from "./status";

const LAST_SPACE = "ruchoir.space";

type SpaceApi = {
  spaces: Loaded<Workspace[]>;
  status: ReturnType<typeof spaceStatus>;
  current: Workspace | null;
  select: (id: string) => void;
};

const SpaceContext = createContext<SpaceApi | null>(null);

export function SpaceProvider({ children }: { children: ReactNode }) {
  const spaces = useLoad("spaces", (signal) => getWorkspaces(signal));
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    void SecureStore.getItemAsync(LAST_SPACE).then((id) => id && setChosen((now) => now ?? id));
  }, []);

  // Unread counts move with every message and notification.
  useReloadOn(
    (e) => e.type === "message" || e.type === "notification" || e.type === "readCursor" || e.type === "spaces",
    spaces.reload,
    1200,
  );

  const select = useCallback((id: string) => {
    setChosen(id);
    void SecureStore.setItemAsync(LAST_SPACE, id);
  }, []);

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
