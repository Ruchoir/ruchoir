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
  /** The public channel every newly invited person joins. */
  defaultChannelId?: string;
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
  /** How much this space notifies the caller, for its conversations left on `default`. */
  notifyLevel: NotifyLevel;
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
  /** Why it is in that state. An accepted invitation is finished, not broken. */
  status: InvitationStatus;
};

/** The four states an invitation can be in, as the API reports them. */
export type InvitationStatus = "active" | "accepted" | "revoked" | "expired";

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
  /**
   * The space roles this channel admits, when it is reserved to some of them. Absent means everyone:
   * a channel is unrestricted until somebody draws the line.
   */
  allowedRoles?: string[];
  /** How much this channel notifies the signed-in user, as stored on their membership. */
  notify?: ConversationNotify;
};

/**
 * One conversation's notification setting for the signed-in user, as the server holds it.
 *
 * Mirrors `ChannelNotifPref` in `features/app/notifications.ts`, which is what the screens read;
 * declared here because the data seam does not import from the features.
 */
export type ConversationNotify = { level: NotifyLevel; muted: boolean };

/** `default` defers to the level above (conversation, then space, then one's own preferences). */
export type NotifyLevel = "default" | "all" | "mentions" | "none";

export type DirectMessage = {
  id: string;
  name: string;
  presence: Presence;
  unread: number;
  bot?: boolean;
  /** The counterpart's user id for a 1:1 DM (for presence overlay); absent for a group. */
  userId?: string;
  /** How much this conversation notifies the signed-in user. */
  notify?: ConversationNotify;
};

export type Profile = {
  name: string;
  /** What they do, in their own words; absent when they have not written one. */
  role?: string;
  presence: Presence;
  email: string;
  /**
   * IANA timezone the person chose; absent when they have not chosen one.
   *
   * The time itself is not carried: it would be stale the moment it was computed. Screens derive it
   * from this with `useLocalTime`, which keeps it current while it is on screen.
   */
  timezone?: string;
  /** The language they read the interface in, as a tag; absent when they have not chosen one. */
  locale?: string;
  pronouns?: string;
  bio?: string;
  bot?: boolean;
  /**
   * Whether this person administers the instance.
   *
   * Shown on the profile because account recovery without a mail relay ends with "ask an
   * administrator", and that only works if they can be told apart from everyone else.
   */
  instanceAdmin?: boolean;
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
  /** Size in bytes, as the API gives it: the words and the separators belong to the reader's language. */
  sizeBytes: number;
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
 * A link preview, read from the page by the server (`apps/api/src/messaging/unfurl.rs`) and stored
 * with the message, never fetched by the browser: a reader's browser must not contact an address
 * because someone else wrote it, and the CSP would refuse it anyway. It arrives with the message,
 * or a moment later as a `message.updated` frame once the server has read the page.
 */
export type LinkPreview = {
  url: string;
  domain: string;
  /** Absent when the page gave a description but no title: the card then leads with the domain. */
  title?: string;
  description?: string;
  /** The site's colour, `#rrggbb`: its `theme-color`, or the dominant colour of its image. */
  color?: string;
  /** Same-origin thumbnail of the site's preview image, served by the API. */
  imageUrl?: string;
  /** The original image's size, for the aspect ratio. */
  imageWidth?: number;
  imageHeight?: number;
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
  /**
   * Arrived while the conversation was being watched (received live, caught up, or just sent), as
   * opposed to loaded with the history: drawn with a short entrance so it is noticed.
   */
  fresh?: boolean;
  /** "system" for join/leave and similar notices; defaults to a normal message. */
  kind?: MessageKind;
  author: string;
  /** Author's user id, when known (absent for system messages and optimistic local rows). */
  authorId?: string;
  /**
   * When it was sent, as the API gives it (RFC 3339).
   *
   * Carried raw rather than as a formatted string: the day and the seconds are what decides whether
   * consecutive messages from one person are drawn as one block, and the words around the time
   * ("Hier", "Yesterday") belong to whoever is reading rather than to whoever fetched it.
   */
  createdAt: string;
  body: string;
  /**
   * What happened, for a system row the API did not give a body.
   *
   * The event and the person it is about, rather than a sentence: "Alice a rejoint l'espace" is one
   * language's way of saying it, and the row is drawn long after the fetch that produced it.
   */
  /** `detail` is the one fact some sentences need (a channel's new name, its new topic). */
  system?: { event: SystemEvent; actor: string; detail?: string };
  /** Icon for a system message. */
  systemIcon?: string;
  attachment?: MessageAttachment;
  /** Every non-image attachment, in upload order. */
  attachments?: MessageAttachment[];
  link?: LinkPreview;
  image?: InlineImage;
  /** Every image attachment, in upload order. */
  images?: InlineImage[];
  reactions?: Reaction[];
  /**
   * The root message this one answers, when it is a thread reply.
   *
   * A reply never belongs in the feed: the history endpoint leaves them out, and the live stream
   * carries them like any other message, so this is what tells the two apart on arrival.
   */
  parentId?: string;
  replies?: number;
  /**
   * The last few people who answered in this message's thread, most recent first.
   *
   * Names, because that is what a row has to draw a face from (the roster holds the pictures, keyed
   * by name). Capped by the API; a client that shows fewer shows the first of them.
   */
  replyAuthors?: string[];
  imported?: boolean;
  pinned?: boolean;
  /** Who pinned it, when it is pinned: only they (or a moderator) may take it down. */
  pinnedBy?: string;
  edited?: boolean;
  /**
   * When it was last edited (RFC 3339), when it was. A message edited long after it was sent says
   * so beside the tag: "(modifié)" alone under yesterday's message does not tell the reader that its
   * text changed this morning.
   */
  editedAt?: string;
  deleted?: boolean;
  /** Whether the current user saved (bookmarked) this message. */
  saved?: boolean;
};

/** The system events the API reports, each with a sentence in every dictionary. */
export type SystemEvent =
  | "member_joined"
  | "member_left"
  | "member_removed"
  | "channel_joined"
  | "channel_left"
  | "channel_removed"
  | "channel_created"
  | "channel_renamed"
  | "channel_topic_changed"
  | "channel_topic_cleared"
  | "channel_made_private"
  | "channel_made_public"
  | "channel_archived"
  | "channel_unarchived"
  | "channel_access_changed";

export type SpaceFileKind = "file" | "file-text" | "file-spreadsheet" | "image" | "folder";

export type SpaceFile = {
  /** File/folder id, when backed by the API (absent for mock/optimistic entries). */
  id?: string;
  name: string;
  kind: SpaceFileKind;
  /** Size in bytes; zero for a folder, which has none of its own. */
  sizeBytes: number;
  by: string;
  /** Last change, RFC 3339. */
  updatedAt: string;
  source: ImportSource;
  version: string;
  /** Whether the file was migrated from another tool (the API exposes the flag, not the connector). */
  imported?: boolean;
  /** Same-origin URL of the server-generated thumbnail, when there is one (images). */
  thumbnailUrl?: string;
};
