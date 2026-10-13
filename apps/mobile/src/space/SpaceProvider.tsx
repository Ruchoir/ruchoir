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
import { useRealtimeEvent } from "../realtime/RealtimeProvider";

const LAST_SPACE = "ruchoir.space";

type SpaceApi = {
  spaces: Loaded<Workspace[]>;
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

  // Unread counts move with every message and notification; a burst is folded into one reload.
  const { reload } = spaces;
  const [pending, setPending] = useState(false);
  useRealtimeEvent((event) => {
    if (event.type === "message" || event.type === "notification" || event.type === "readCursor" || event.type === "spaces") {
      setPending(true);
    }
  });
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(false);
      reload();
    }, 1200);
    return () => clearTimeout(timer);
  }, [pending, reload]);

  const select = useCallback((id: string) => {
    setChosen(id);
    void SecureStore.setItemAsync(LAST_SPACE, id);
  }, []);

  const list = spaces.data;
  const current = useMemo(() => list?.find((w) => w.id === chosen) ?? list?.[0] ?? null, [list, chosen]);
  const api = useMemo(() => ({ spaces, current, select }), [spaces, current, select]);
  return <SpaceContext.Provider value={api}>{children}</SpaceContext.Provider>;
}

export function useSpace(): SpaceApi {
  const api = useContext(SpaceContext);
  if (!api) throw new Error("useSpace outside SpaceProvider");
  return api;
}
