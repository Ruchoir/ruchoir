/** The main content views the sidebar can switch between. */
export type AppView =
  | "channel"
  | "files"
  | "settings"
  | "prefs"
  | "instance-admin"
  // Bringing a workspace over from another product: full-screen, open to anyone signed in (scoped
  // to their own spaces unless they administer the instance).
  | "import"
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
