/**
 * What the desktop app's core says about the instances, as the interface reads it (shapes of
 * `apps/desktop/src-tauri`'s `InstanceView`, `Summary` and `DesktopSettings`), and the short name the
 * rail gives an instance. Free of Tauri, so Node tests it; the calls are in `bridge.ts`.
 */

export type SpaceSummary = {
  id: string;
  slug: string;
  name: string;
  /** Instance-relative; prefix with the instance's base (`/i/<id>`). */
  icon_url: string | null;
  unread: number;
  mentions: number;
};

export type Summary = { spaces: SpaceSummary[]; unread_notifications: number };

export type DesktopSettings = { launch_at_login: boolean; close_to_tray: boolean; close_notice_seen: boolean };

/** Parts of a host that name the software or the web, not the organisation. */
const GENERIC = new Set(["www", "app", "ruchoir"]);

/**
 * The rail's heading for an instance: the telling part of its host ("ruchoir.boulot.fr" is
 * "boulot", "alpha.ruchoir.com" is "alpha"). The full host is in the heading's tooltip.
 */
export function shortLabel(host: string): string {
  const labels = host.replace(/:\d+$/, "").split(".").filter(Boolean);
  const named = labels.length > 1 ? labels.slice(0, -1) : labels;
  return named.find((part) => !GENERIC.has(part)) ?? named[0] ?? host;
}
