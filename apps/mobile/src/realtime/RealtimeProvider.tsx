/**
 * One realtime connection for the signed-in session, shared by every screen.
 *
 * Screens subscribe to the events they draw ({@link useRealtimeEvent}) and refetch when
 * {@link useResync} moves: after a reconnection, and whenever the app comes back to the foreground,
 * where iOS may have frozen the socket. Refetching rather than replaying deltas keeps one path for
 * "what is true now", and {@link mergeMessages} keeps a message that arrives both ways from showing twice.
 */
import { connectRealtime, type ApiMessage, type Presence } from "@ruchoir/client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";

export type RealtimeEvent =
  | { type: "message"; change: "created" | "updated" | "deleted"; conversationId: string; message: ApiMessage }
  | { type: "notification" }
  | { type: "readCursor"; conversationId: string }
  | { type: "presence"; userId: string; presence: Presence }
  | { type: "spaces" }
  | { type: "channels"; spaceId?: string }
  | { type: "calendar" }
  | { type: "files"; spaceId: string };

type Listener = (event: RealtimeEvent) => void;

const RevisionContext = createContext(0);
const BusContext = createContext<Set<Listener> | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const [listeners] = useState(() => new Set<Listener>());

  useEffect(() => {
    const emit = (event: RealtimeEvent) => listeners.forEach((listen) => listen(event));
    const open = () =>
      connectRealtime({
        onReconnect: () => setRevision((r) => r + 1),
        onMessageCreated: (conversationId, message) => emit({ type: "message", change: "created", conversationId, message }),
        onMessageUpdated: (conversationId, message) => emit({ type: "message", change: "updated", conversationId, message }),
        onMessageDeleted: (conversationId, message) => emit({ type: "message", change: "deleted", conversationId, message }),
        onNotification: () => emit({ type: "notification" }),
        onReadCursor: (conversationId) => emit({ type: "readCursor", conversationId }),
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
    let connection = open();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      connection.close();
      connection = open();
      setRevision((r) => r + 1);
    });
    return () => {
      subscription.remove();
      connection.close();
    };
  }, [listeners]);

  return (
    <BusContext.Provider value={listeners}>
      <RevisionContext.Provider value={revision}>{children}</RevisionContext.Provider>
    </BusContext.Provider>
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
