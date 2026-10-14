/**
 * An invitation link as a person pastes it: the instance it belongs to and its token.
 *
 * The API e-mails `https://<instance>/invite?token=<64 hex>` (and shows the same address to whoever
 * shares a link). The link names the server, which is the point: someone invited does not know their
 * instance's address, and pasting the link is how the app learns it. A bare token is accepted for the
 * server already chosen. Written without `URL`, as `session/server.ts` is, so Node tests it as is.
 */
import { normalizeServer } from "../session/server.ts";

export type InvitationLink = { origin: string; token: string };

const TOKEN = /^[0-9a-f]{64}$/;

export function parseInvitationLink(text: string, current: string | null): InvitationLink | null {
  const input = text.trim();
  if (!input) return null;
  if (TOKEN.test(input.toLowerCase())) return current ? { origin: current, token: input.toLowerCase() } : null;

  const match = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?/i.exec(input);
  if (!match) return null;
  const server = normalizeServer(match[1]);
  if (!server.ok) return null;
  if ((match[2] ?? "").replace(/\/+$/, "") !== "/invite") return null;
  const token = (match[3] ?? "")
    .slice(1)
    .split("&")
    .map((pair) => pair.split("="))
    .find(([name]) => name === "token")?.[1]
    ?.toLowerCase();
  return token && TOKEN.test(token) ? { origin: server.origin, token } : null;
}
