/**
 * One realtime connection for the signed-in session, shared by every screen.
 *
 * Screens subscribe to the events they draw ({@link useRealtimeEvent}) and refetch when
 * {@link useResync} moves: after a reconnection, and whenever the app comes back to the foreground,
 * where iOS may have frozen the socket. Refetching rather than replaying deltas keeps one path for
 * "what is true now", and {@link mergeMessages} keeps a message that arrives both ways from showing twice.
 */
import type { RealtimeConnection } from "@ruchoir/client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { useApi } from "../api/useApi";
import { handlersFor, type RealtimeEvent } from "./events";

export type { RealtimeEvent } from "./events";

type Listener = (event: RealtimeEvent) => void;

type Actions = {
  /** Tell the others in a conversation that I am writing. */
  sendTyping: (conversationId: string) => void;
  /** Deliver an event to every screen as if it came from the server (a message I just sent). */
  emit: (event: RealtimeEvent) => void;
};

const RevisionContext = createContext(0);
const BusContext = createContext<Set<Listener> | null>(null);
const ActionsContext = createContext<Actions>({ sendTyping: () => {}, emit: () => {} });

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { connectRealtime } = useApi();
  const [revision, setRevision] = useState(0);
  const [listeners] = useState(() => new Set<Listener>());
  const connection = useRef<RealtimeConnection | null>(null);
  const actions = useMemo<Actions>(
    () => ({
      sendTyping: (conversationId) => connection.current?.sendTyping(conversationId),
      emit: (event) => listeners.forEach((listen) => listen(event)),
    }),
    [listeners],
  );

  useEffect(() => {
    const emit = actions.emit;
    const open = () => connectRealtime(handlersFor(emit, () => setRevision((r) => r + 1)));
    connection.current = open();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      connection.current?.close();
      connection.current = open();
      setRevision((r) => r + 1);
    });
    return () => {
      subscription.remove();
      connection.current?.close();
      connection.current = null;
    };
  }, [actions, connectRealtime]);

  return (
    <ActionsContext.Provider value={actions}>
      <BusContext.Provider value={listeners}>
        <RevisionContext.Provider value={revision}>{children}</RevisionContext.Provider>
      </BusContext.Provider>
    </ActionsContext.Provider>
  );
}

/** A number that moves when everything on screen should be fetched again. */
export function useResync(): number {
  return useContext(RevisionContext);
}

/** Hear the live events; the latest `listener` is always the one called. */
export function useRealtimeEvent(listener: Listener): void {
  const bus = useContext(BusContext);
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    if (!bus) return;
    const relay: Listener = (event) => latest.current(event);
    bus.add(relay);
    return () => {
      bus.delete(relay);
    };
  }, [bus]);
}

/** Send the typing signal, or deliver a local event to every screen. */
export function useRealtimeActions(): Actions {
  return useContext(ActionsContext);
}
