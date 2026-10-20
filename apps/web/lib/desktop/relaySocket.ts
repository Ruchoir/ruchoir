/**
 * The interface's realtime socket in the desktop app.
 *
 * The app's Rust core holds one socket per instance (it carries the bearer, which the interface
 * never sees) and relays its frames as events tagged with the instance. This object puts those
 * events behind the shape of a `WebSocket`, so `@ruchoir/client`'s realtime code runs unchanged:
 * it opens when the core's socket is open, delivers that instance's frames, and closes cleanly
 * (`wasClean: true`, so the client reconnects rather than falling back to server-sent events) when
 * the core's socket drops or the window is minimised.
 */

/** Tauri's `listen`, narrowed to what the relay uses. */
export type Listen = (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
/** Tauri's `invoke`, narrowed to what the relay uses. */
export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type SocketPayload = { instance?: string; frame?: string };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export function createRelaySocket(instance: string, listen: Listen, invoke: Invoke): WebSocket {
  let readyState = CONNECTING;
  const unlisten: (() => void)[] = [];
  let ended = false;

  const socket = {
    get readyState() {
      return readyState;
    },
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    send(frame: string) {
      if (readyState !== OPEN) return;
      void invoke("socket_send", { instance, frame });
    },
    close() {
      end();
    },
  };

  const mine = (payload: unknown): payload is SocketPayload =>
    typeof payload === "object" && payload !== null && (payload as SocketPayload).instance === instance;

  const open = () => {
    if (ended || readyState === OPEN) return;
    readyState = OPEN;
    socket.onopen?.({ type: "open" } as Event);
  };

  function end() {
    if (ended) return;
    ended = true;
    readyState = CLOSED;
    unlisten.splice(0).forEach((stop) => stop());
    socket.onclose?.({ type: "close", wasClean: true, code: 1000, reason: "" } as CloseEvent);
  }

  const subscribe = (event: string, handler: (payload: SocketPayload) => void) =>
    listen(event, (payload) => {
      if (!ended && mine(payload)) handler(payload);
    }).then((stop) => {
      // A socket closed before Tauri answered drops its listener at once.
      if (ended) stop();
      else unlisten.push(stop);
    });

  void Promise.all([
    subscribe("socket:open", open),
    subscribe("socket:message", (payload) => {
      if (readyState === OPEN && typeof payload.frame === "string") {
        socket.onmessage?.({ type: "message", data: payload.frame } as MessageEvent);
      }
    }),
    subscribe("socket:closed", end),
  ]).then(async () => {
    if (!ended && (await invoke("socket_is_open", { instance })) === true) open();
  });

  return socket as unknown as WebSocket;
}
