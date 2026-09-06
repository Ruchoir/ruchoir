/**
 * Domain types for the app shell. These describe the shape the UI consumes; they are
 * intentionally close to what the Rust API will return so that we can later swap the mock
 * implementation of the data seam (lib/data) for real HTTP calls without touching views.
 */
import type { Presence } from "@/components/ds";

export type ImportSource = "Nextcloud" | "Slack" | "Mattermost" | "Ruchoir";

export type Workspace = {
  id: string;
  name: string;
  members: number;
};

export type ChannelType = "public" | "private" | "archived";

export type Channel = {
  id: string;
  name: string;
  fav: boolean;
  unread: number;
  type: ChannelType;
  /** Short one-line channel purpose, shown in the header meta and intro. */
  topic?: string;
  /** Set when the channel was migrated from another tool. */
  imported?: ImportSource;
  /**
   * Whether the signed-in user has joined the channel. A public channel is readable either way, but
   * only members receive its real-time pushes, so the menus offer joining or leaving accordingly.
   */
  member?: boolean;
};

export type DirectMessage = {
  id: string;
  name: string;
  presence: Presence;
  unread: number;
  bot?: boolean;
  /** The counterpart's user id for a 1:1 DM (for presence overlay); absent for a group. */
  userId?: string;
};

export type Profile = {
  name: string;
  role: string;
  presence: Presence;
  email: string;
  timezone: string;
  /** Mocked local time string for the user's timezone. */
  localTime: string;
  pronouns?: string;
  bio?: string;
  bot?: boolean;
};

export type Reaction = {
  /** The reaction emoji (native Unicode). */
  emoji: string;
  count: number;
  /** Whether the current user is among the reactors (drives the toggle + highlight). */
  mine?: boolean;
  /** Display names of the reactors, for the "who reacted" tooltip and list. */
  users?: string[];
};

export type MessageAttachment = {
  name: string;
  size: string;
  /** Icon name for the file kind (file, file-text, file-spreadsheet, ...). */
  kind: string;
};

/**
 * A link unfurl (preview). Data-model implication: these fields must be fetched server-side and
 * stored (a message -> link_preview relation), not resolved in the browser, so the client
 * stays sovereign and cannot be used to probe arbitrary URLs on a viewer's behalf.
 */
export type LinkPreview = {
  url: string;
  domain: string;
  title: string;
  description?: string;
  /** Whether the unfurl carried a thumbnail (rendered as a placeholder in this exploration). */
  hasImage?: boolean;
};

/**
 * An inline image attachment. Data-model / storage implication: needs a stored thumbnail plus intrinsic
 * dimensions to reserve layout space before load. No real bytes here: the exploration renders
 * a locally-generated placeholder, never a remote image (sovereignty + CSP).
 */
export type InlineImage = {
  alt: string;
  width: number;
  height: number;
};

export type MessageKind = "message" | "system";

export type Message = {
  /** Stable message id. A UUID string from the API (was a numeric id under the mock seam). */
  id: string;
  /** "system" for join/leave and similar notices; defaults to a normal message. */
  kind?: MessageKind;
  author: string;
  /** Author's user id, when known (absent for system messages and optimistic local rows). */
  authorId?: string;
  time: string;
  body: string;
  /** Icon for a system message. */
  systemIcon?: string;
  attachment?: MessageAttachment;
  link?: LinkPreview;
  image?: InlineImage;
  reactions?: Reaction[];
  replies?: number;
  imported?: boolean;
  pinned?: boolean;
  edited?: boolean;
  deleted?: boolean;
  /** Whether the current user saved (bookmarked) this message. */
  saved?: boolean;
  /**
   * Names who have read this message. Data-model implication (to settle before the schema freezes):
   * a per-message-per-user receipt (this shape, heavy, privacy-sensitive) vs a single
   * per-channel-per-user read cursor (light, Slack-style). This exploration renders the former
   * only to visualize it; the storage decision is open.
   */
  readBy?: string[];
};

export type SpaceFileKind = "file" | "file-text" | "file-spreadsheet" | "folder";

export type SpaceFile = {
  /** File/folder id, when backed by the API (absent for mock/optimistic entries). */
  id?: string;
  name: string;
  kind: SpaceFileKind;
  size: string;
  by: string;
  when: string;
  source: ImportSource;
  version: string;
  /** Whether the file was migrated from another tool (the API exposes the flag, not the connector). */
  imported?: boolean;
};
