"use client";

import type { NotifPrefs } from "./notifications";
import { DEFAULT_NOTIF_PREFS } from "./notifications";

/**
 * Notifications that reach someone who is not looking at Ruchoir.
 *
 * Everything in the preferences screen described this behaviour ("notifications de bureau et
 * sonores", quiet hours, a sound on each one) and none of it existed: the switches were saved and
 * read by nothing. This is the missing half. The in-app inbox, the badges and the tab title are
 * unchanged; what is added is the part that works while the app is in another tab or behind another
 * window, which is the only time a notification has anything to tell you.
 *
 * Two deliberate limits:
 *
 * - **Permission is never requested on load.** A page that asks the moment it opens is the reason
 *   people block notifications for good, and a denial cannot be taken back from the page: it has to
 *   be undone in the browser's own settings, which most people never find. So the request comes
 *   from a control in the preferences, where the person has just said they want this.
 * - **Nothing is sent while the app is on screen and focused.** A system notification laid over the
 *   window you are already reading is noise; the sidebar badge and the sound are enough there.
 *
 * This is the browser's `Notification`, not Web Push: it needs the tab to exist, in some window,
 * somewhere. Notifying a browser that is closed altogether needs a service worker, a push service
 * and keys on the server, which is a separate piece of work.
 */

/** What the browser will currently allow. `unsupported` covers older browsers and any SSR pass. */
export type NotifPermission = "unsupported" | "default" | "granted" | "denied";

export function notificationPermission(): NotifPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as NotifPermission;
}

/**
 * Subscribe to changes of that permission, for `useSyncExternalStore`.
 *
 * The browser gives no event when it changes, and the only thing that can change it from inside the
 * page is our own request, so the subscription exists to be woken by that. A change made in the
 * browser's own settings is picked up on the next load, which is when the page is re-rendered
 * anyway.
 */
const permissionListeners = new Set<() => void>();

export function subscribeToNotificationPermission(onChange: () => void): () => void {
  permissionListeners.add(onChange);
  return () => {
    permissionListeners.delete(onChange);
  };
}

/** The snapshot to render before the browser exists: the static export has no `Notification`. */
export function serverNotificationPermission(): NotifPermission {
  return "unsupported";
}

/**
 * Ask for permission, from a user gesture.
 *
 * Resolves to the outcome, which may be `denied`: browsers treat a dismissal as a refusal, and some
 * refuse the prompt outright when it did not follow a click.
 */
export async function requestNotificationPermission(): Promise<NotifPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    return (await Notification.requestPermission()) as NotifPermission;
  } catch {
    return notificationPermission();
  } finally {
    for (const listener of permissionListeners) listener();
  }
}

/** Whether the app is out of sight: another tab, another window, or minimised. */
export function appIsAway(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden" || !document.hasFocus();
}

/**
 * Whether `at` falls inside the configured quiet window.
 *
 * The window is allowed to run past midnight, which is the ordinary case (21:00 to 08:00), so it is
 * read as two ranges when the start is later than the end. The bounds are the user's local time
 * because that is what they typed.
 */
export function inQuietHours(prefs: NotifPrefs, at: Date = new Date()): boolean {
  if (!prefs.quietHours) return false;
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":");
    const hours = Number(h);
    const mins = Number(m);
    return Number.isFinite(hours) && Number.isFinite(mins) ? hours * 60 + mins : null;
  };
  const from = minutes(prefs.quietFrom ?? DEFAULT_NOTIF_PREFS.quietFrom);
  const to = minutes(prefs.quietTo ?? DEFAULT_NOTIF_PREFS.quietTo);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * A short two-note chime, synthesised rather than played from a file.
 *
 * No asset to ship, no request at the moment it matters, and nothing fetched from anywhere: a sound
 * file would be one more thing to load, and the point of this is that it happens instantly. The
 * context is created once, lazily, because a browser refuses one before the page has been
 * interacted with and keeps it suspended afterwards.
 */
let audio: AudioContext | null = null;

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    audio = audio ?? new Ctor();
    if (audio.state === "suspended") void audio.resume();
    const start = audio.currentTime;
    // Two rising notes, quiet and short. Long enough to be heard across a room, short enough that
    // hearing it twenty times a day is not a punishment.
    for (const [index, frequency] of [660, 880].entries()) {
      const at = start + index * 0.09;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      // Ramped rather than switched: an abrupt start and stop is heard as a click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.06, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    }
  } catch {
    // An audio context can be refused outright (an autoplay policy, a locked-down browser). A
    // notification without its sound is still a notification.
  }
}

export type DesktopNotification = {
  title: string;
  body: string;
  /** Groups notifications: a second one from the same conversation replaces the first. */
  tag: string;
  /** Run when the person clicks it, after the window has been brought forward. */
  onClick: () => void;
};

/**
 * Show one system notification, if the browser allows it.
 *
 * Silent, because the sound is ours to play: the preference is a single switch, and letting the
 * operating system add its own on top would make the switch a lie in one direction and a double
 * chime in the other.
 */
export function showDesktopNotification(n: DesktopNotification): void {
  if (notificationPermission() !== "granted") return;
  try {
    const notification = new Notification(n.title, {
      body: n.body,
      tag: n.tag,
      icon: "/icon.png",
      silent: true,
    });
    notification.onclick = () => {
      // Bring the window forward first: the click handler runs in a page that may be behind three
      // others, and jumping to a message nobody can see is not an answer.
      window.focus();
      notification.close();
      n.onClick();
    };
  } catch {
    // Some browsers throw here rather than returning a refusal (a page without a service worker on
    // Android, for one). The in-app inbox has the notification either way.
  }
}
