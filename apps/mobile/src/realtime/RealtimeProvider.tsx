/**
 * One realtime connection for the signed-in session, shared by every screen.
 *
 * Screens subscribe to the events they draw ({@link useRealtimeEvent}) and refetch when
 * {@link useResync} moves: after a reconnection, and whenever the app comes back to the foreground,
 * where iOS may have frozen the socket. Refetching rather than replaying deltas keeps one path for
 * "what is true now", and {@link mergeMessages} keeps a message that arrives both ways from showing twice.
 */
import { connectRealtime, type ApiMessage, type Presence, type RealtimeConnection } from "@ruchoir/client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

export type RealtimeEvent =
  | { type: "message"; change: "created" | "updated" | "deleted"; conversationId: string; message: ApiMessage }
  | { type: "notification" }
  | { type: "readCursor"; conversationId: string; userId: string; lastReadMessageId: string }
  | { type: "typing"; conversationId: string; userId: string }
  | { type: "presence"; userId: string; presence: Presence }
  | { type: "spaces" }
  | { type: "channels"; spaceId?: string }
  | { type: "calendar" }
  | { type: "files"; spaceId: string };

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
    const open = () =>
      connectRealtime({
        onReconnect: () => setRevision((r) => r + 1),
        onMessageCreated: (conversationId, message) => emit({ type: "message", change: "created", conversationId, message }),
        onMessageUpdated: (conversationId, message) => emit({ type: "message", change: "updated", conversationId, message }),
        onMessageDeleted: (conversationId, message) => emit({ type: "message", change: "deleted", conversationId, message }),
        onNotification: () => emit({ type: "notification" }),
        onReadCursor: (conversationId, userId, lastReadMessageId) =>
          emit({ type: "readCursor", conversationId, userId, lastReadMessageId }),
        onTyping: (conversationId, userId) => emit({ type: "typing", conversationId, userId }),
        onPresence: (userId, presence) => emit({ type: "presence", userId, presence }),
        onSpaceUpdated: () => emit({ type: "spaces" }),
        onSpaceRemoved: () => emit({ type: "spaces" }),
        onChannelCreated: () => emit({ type: "channels" }),
        onChannelUpdated: () => emit({ type: "channels" }),
        onChannelDeleted: (spaceId) => emit({ type: "channels", spaceId }),
        onCalendarChanged: () => emit({ type: "calendar" }),
        onFilesUpdated: (spaceId) => emit({ type: "files", spaceId }),
        onFilesDeleted: (spaceId) => emit({ type: "files", spaceId }),
      });
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
  }, [actions]);

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
