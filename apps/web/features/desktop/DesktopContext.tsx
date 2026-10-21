"use client";

import { createContext, useContext } from "react";
import type { DesktopSettings, SpaceSummary } from "@/lib/desktop/instances";
import type { AppNotification } from "@/features/app/notifications";
import type { OtherFeed } from "./commonBell";

/** Another instance the desktop app holds, as the rail draws it. */
export type OtherInstance = {
  id: string;
  /** The rail's heading ("boulot"). */
  label: string;
  /** Its full host, for the heading's tooltip. */
  host: string;
  state: "signedIn" | "signedOut";
  spaces: SpaceSummary[];
  /** Its base on the app's protocol (`/i/<id>`), for its spaces' icons. */
  base: string;
};

/**
 * What the interface may ask of the desktop app (ADR 0008, step 2), read with `useDesktop()`.
 * `null` on the web and outside the desktop root: every reader treats it as "not the desktop".
 */
export type DesktopBridge = {
  /** The open instance's heading and host. */
  instanceLabel: string;
  instanceHost: string;
  /** Every other instance, in the list's order. */
  others: OtherInstance[];
  /** Open an instance at a path of the interface (`/e/<space>`), asking first if files are being sent. */
  open: (instanceId: string, path: string) => void;
  addInstance: () => void;
  signIn: (instanceId: string) => void;
  /** Forget the open instance (the app keeps the others). */
  removeOpen: () => void;
  /** The open instance's notification settings were saved. */
  preferencesSaved: () => void;
  settings: DesktopSettings | null;
  setSettings: (settings: DesktopSettings) => void;
  /** Every other signed-in instance's first page of notifications, for the common bell. */
  otherNotifications: OtherFeed[];
  /** Open a notification of another instance where it happened. */
  openNotification: (instanceId: string, n: AppNotification) => void;
  /** Mark one of another instance's notifications read (unread stays local, as on the web). */
  markRead: (instanceId: string, id: string, read: boolean) => void;
  markAllOthersRead: () => void;
};

export const DesktopContext = createContext<DesktopBridge | null>(null);

/** The desktop bridge, or `null` on the web. */
export function useDesktop(): DesktopBridge | null {
  return useContext(DesktopContext);
}
