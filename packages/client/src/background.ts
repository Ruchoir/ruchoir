/**
 * Writes the app makes on its own, that nobody asked for: marking what was read, telling others one
 * is typing, registering for pushes, keeping an editor session alive. During a preview they are not
 * sent at all, and if one still reaches the server its refusal is silent: only what the person
 * started may speak.
 */
export function isBackgroundWrite(request: { method: string; path: string }): boolean {
  const method = request.method.toUpperCase();
  const path = request.path.split("?")[0];
  if (method === "PUT") {
    return /^\/conversations\/[^/]+\/read$/.test(path) || path === "/notifications/read" || /^\/notifications\/[^/]+\/read$/.test(path) || path === "/push/devices" || path === "/push/subscription";
  }
  if (method === "POST") {
    return path === "/realtime/typing" || /^\/files\/[^/]+\/office\/heartbeat$/.test(path);
  }
  return false;
}
