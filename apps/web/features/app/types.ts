/** The main content views the sidebar can switch between. */
export type AppView =
  | "channel"
  | "files"
  | "settings"
  | "prefs"
  | "instance-admin"
  | "threads"
  | "mentions"
  | "saved";

/** The optional right-hand panel inside the channel view. */
export type ChannelPanel = "files" | "members" | "pinned" | "search" | null;

/** A transient toast notification for simulated actions. */
export type Toast = {
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  description?: string;
};
