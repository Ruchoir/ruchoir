/**
 * "Open the search", asked by the desktop app's title bar, which sits outside the interface and
 * cannot reach its state. The interface listens and opens its global search, as its shortcut does.
 * On the web nothing ever asks, so the listener stays idle.
 */

const EVENT = "ruchoir:open-search";
const bus: EventTarget = new EventTarget();

/** Ask the interface to open its search. */
export function requestSearch(): void {
  bus.dispatchEvent(new Event(EVENT));
}

/** Hear the requests. Returns the function that stops listening. */
export function onSearchRequest(handler: () => void): () => void {
  bus.addEventListener(EVENT, handler);
  return () => bus.removeEventListener(EVENT, handler);
}
