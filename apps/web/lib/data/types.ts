/**
 * Domain types for the app shell. These describe the shape the UI consumes; they are
 * intentionally close to what the Rust API will return so that we can later swap the mock
 * implementation of the data seam (lib/data) for real HTTP calls without touching views.
 */
import type { Presence } from "@/components/ds";

export type ImportSource = "Nextcloud" | "Slack" | "Mattermost" | "Ruchoir";

/**
 * What a user chooses about their own availability, which is not the same thing as the dot other
 * people see.
 *
 * `Presence` is the result: what someone is, right now, as computed by the server from a live
 * connection and this choice. `PresenceChoice` is the instruction. `auto` means "say whether I am
 * connected", and it is the one that was missing: the menu only ever wrote a fixed override, so the
 * first pick was permanent and everyone stayed lit whether they were there or not.
 *
 * `auto` is not named anywhere in the interface and is not something to pick. It is what the
 * ordinary "En ligne" entry sends, and it is the default, because following the connection is what
 * the product does when nobody has asked for anything else.
 */
export type PresenceChoice = "auto" | "away" | "busy" | "invisible";

export type Workspace = {
  id: string;
  name: string;
  members: number;
  /** The caller's own role in the space: `owner`, `admin`, `member` or `guest`. Gates administration. */
  role: string;
  /** URL handle, used to address the space in the path or as a subdomain. */
  slug: string;
  /** Same-origin URL of the uploaded icon; absent means the generated mark. */
  iconUrl?: string;
  /**
   * Unread messages in the conversations the caller has joined here. Drives the rail's discreet
   * activity dot, never a number: one busy channel would make every space show a meaningless figure.
   */
  unread: number;
  /**
   * Unread notifications here (mentions, thread replies, direct messages): what was addressed to the
   * caller personally, and the only counter shown as a number.
   */
  mentions: number;
};

/**
 * An outstanding invitation into a space, as listed to an administrator.
 *
 * Never carries the token: the API stores only its digest and returns the usable link once, at
 * creation. A lost link is replaced by revoking the invitation and issuing another.
 */
export type Invitation = {
  id: string;
  /** Address it was sent to; absent for a shareable link. */
  email?: string;
  /** Role granted on acceptance: `admin`, `member` or `guest`. */
  role: string;
  /** Display name of whoever issued it, when that account still exists. */
  invitedBy?: string;
  uses: number;
  /** Maximum acceptances; absent means unlimited. */
  maxUses?: number;
  /** RFC 3339 expiry, when it expires. */
  expiresAt?: string;
  createdAt: string;
  /** Whether it would be accepted right now. */
  usable: boolean;
};

/** A freshly created invitation: the row, plus the link, which is shown exactly once. */
export type CreatedInvitation = {
  invitation: Invitation;
  url: string;
  /** Whether the invitation email actually went out. */
  emailed: boolean;
};

/** What someone holding an invitation link is told before they sign in. */
export type InvitationPreview = {
  spaceName: string;
  invitedBy?: string;
  /** Address the invitation is addressed to, so the screen can say which account to use. */
  email?: string;
  role: string;
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
  /** Same-origin URL of the uploaded avatar; absent means the locally generated one. */
  avatarUrl?: string;
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
  /** Stored file id; absent while an optimistic message is still uploading. */
  fileId?: string;
  name: string;
  size: string;
  /** Icon name for the file kind (file, file-text, file-spreadsheet, ...). */
  kind: string;
  /** Same-origin download URL; absent until the file exists server-side. */
  url?: string;
  /** Same-origin URL serving the original bytes inline, for opening in a tab at full quality. */
  previewUrl?: string;
  /** The file was removed from the space: the message keeps a trace of it, without a way to open it. */
  deleted?: boolean;
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
  /** The stored file behind it, so a deletion arriving live can find the messages showing it. */
  fileId?: string;
  alt: string;
  width: number;
  height: number;
  /**
   * Same-origin preview URL. Absent for a message that has not been persisted yet, in which case the
   * placeholder is drawn: never a remote image, per the CSP and the sovereignty rule.
   */
  src?: string;
  /** Same-origin download URL, for saving the original rather than viewing it. */
  downloadUrl?: string;
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
  /**
   * When it was sent, as the API gives it (RFC 3339).
   *
   * `time` is for reading and has already lost the day and the seconds, so it cannot answer "were
   * these two sent within five minutes of each other", which is what decides whether consecutive
   * messages from one person are drawn as one block.
   */
  createdAt?: string;
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
};

export type SpaceFileKind = "file" | "file-text" | "file-spreadsheet" | "image" | "folder";

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
  /** Same-origin URL of the server-generated thumbnail, when there is one (images). */
  thumbnailUrl?: string;
};
