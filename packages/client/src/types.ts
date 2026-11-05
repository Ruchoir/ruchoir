/**
 * Domain types for the app shell. These describe the shape the UI consumes; they are
 * intentionally close to what the Rust API will return so that we can later swap the mock
 * implementation of the data seam (lib/data) for real HTTP calls without touching views.
 */
import type { EventCard } from "./calendar.ts";

/** What someone is, right now, as the server computes it (and the avatar's dot draws it). */
export type Presence = "online" | "away" | "busy" | "offline";

export type ImportSource = "Nextcloud" | "Slack" | "Mattermost" | "Teams" | "Ruchoir";

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
  /** When the caller's own access ends (RFC 3339), for a guest given an end date. */
  expiresAt?: string;
  /**
   * What the caller may do here, by permission name (`files.manage`, `channel.manage`...), when the
   * instance announces the `permissions` feature. Absent from an older instance: fall back to the
   * role.
   */
  myPermissions?: string[];
  /**
   * The edition the space runs: `community`, `enterprise` (a valid licence) or `frozen` (its licence
   * expired: what it configured keeps applying, nothing paid can be changed). `community` from an
   * instance that does not say.
   */
  edition: SpaceEdition;
  /** The space's licence, for its owners alone, when it has one. */
  licence?: SpaceLicence;
  /** The role this session is looking at the space as (read only), while a preview is on. */
  preview?: Preview;
};

export type SpaceEdition = "community" | "enterprise" | "frozen";

/** What an owner reads of the space's licence. */
export type SpaceLicence = {
  seats: number;
  /** Owners and members today; guests take no seat. */
  used: number;
  /** RFC 3339. */
  validUntil: string;
  /** Whole days left, rounded up; 0 once it has passed. */
  expiresInDays: number;
};

/** A group of a space: a named set of people, which may carry roles. */
export type Group = {
  id: string;
  name: string;
  description?: string;
  /** `directory` for a group mirrored from a directory (read-only). */
  source: "manual" | "directory";
  /** Everyone in it, managers included. */
  memberIds: string[];
  managerIds: string[];
  /** The roles it carries, strongest first. */
  roleIds: string[];
  /** The import that made it (`<source>:<job id>`), only for whoever manages groups. */
  importedFrom?: string;
  /**
   * What the caller may do to it. `addNeedsLicence`: the space is free or frozen, so adding a role,
   * or a manager is refused; taking away is not. `addPeopleNeedsLicence`: putting people in this group is refused
   * for the caller for the same reason (the group carries roles, or they act as its manager only).
   */
  may: { edit: boolean; delete: boolean; changeMembers: boolean; changeRoles: boolean; appoint: boolean; addNeedsLicence: boolean; addPeopleNeedsLicence: boolean };
};

/** One role of a space, as `GET /spaces/{id}/roles` lists it (strongest first). */
export type Role = {
  id: string;
  /** `administrator`, `members` or `guests` for a system role, whose name the app translates. */
  systemKey?: "administrator" | "members" | "guests";
  name: string;
  /** One of the design system's pastels. */
  colour?: string;
  position: number;
  /** Permission names, in catalogue order. */
  permissions: string[];
  /** How many hold it (for a base role, the people of that standing). */
  holders: number;
  /** Whether the caller may manage it. */
  manageable: boolean;
};

/** One entry of a space's audit log. */
export type AuditEntry = {
  id: string;
  /** RFC 3339. */
  at: string;
  /** The dotted action (`role.created`, `member.removed`...). */
  action: string;
  /** `members`, `roles`, `channels`, `calendars`, `licence` (or `other`). */
  category: string;
  /** Who did it; absent once their account is deleted. */
  actor?: { id: string; name: string; avatarUrl?: string };
  target: { kind: string; id?: string; label?: string };
  /** Ids, role and permission names, before and after. */
  details: Record<string, unknown>;
};

export type AuditPage = { entries: AuditEntry[]; next?: string };

export type AuditQuery = { actor?: string; category?: string; since?: string; before?: string; limit?: number };

/** How a licence is kept up to date: checked with the licence service, or never. */
export type LicenceMode = "online" | "offline";

/**
 * Where a licence stands: in force, suspended or revoked by its issuer, frozen because the licence
 * service has not answered for 7 days or answered without confirming this licence, ended, not started yet, or refused because the server's clock
 * went back.
 */
export type LicenceStatus = "active" | "suspended" | "revoked" | "unreachable" | "no_status" | "expired" | "not_yet" | "clock";

/** A space's licence as its owner manages it. */
export type LicenceView = {
  licenceId: string;
  organisation: string;
  /** The seats in force (an online licence's issuer may change them). */
  seats: number;
  used: number;
  /** The end in force (RFC 3339). */
  validUntil: string;
  /** `community` is a licence whose start has not come. */
  edition: "enterprise" | "frozen" | "community";
  /** Absent for a licence of the first version, and from an older server. */
  mode?: LicenceMode;
  /** Absent from an older server. */
  status?: LicenceStatus;
  /** Online licences: the last check-in that got an answer (RFC 3339). */
  lastCheckInAt?: string;
  /** When `status` is `unreachable`: since when, if it ever answered. */
  unreachableSince?: string;
  /** The next licence, when one waits to take over. */
  next?: { validFrom: string; validUntil: string; seats: number };
  /** When it was installed (ISO 8601); absent from an instance older than this field. */
  installedAt?: string;
  /** Who installed it; absent once their account is deleted. */
  installedBy?: { id: string; name: string };
};

/** One space's licence as the instance's administrator reads it (`GET /admin/licences`). */
export type AdminLicence = {
  spaceId: string;
  spaceName: string;
  /** The holder named on the licence. */
  organisation: string;
  seats: number;
  used: number;
  /** RFC 3339. */
  validUntil: string;
  /** `invalid` is a stored licence this build cannot verify. */
  edition: "enterprise" | "frozen" | "community" | "invalid";
  mode?: LicenceMode;
  status?: LicenceStatus | "invalid";
  lastCheckInAt?: string;
};

/**
 * Why the server refused, when it said so by name: what the screens explain in plain words (see
 * `refusalOf`). Codes the app does not know read as no refusal at all, and the generic message shows.
 */
export type Refusal =
  | { code: "seats_full"; seats: number; pricingUrl: string; space?: string; used?: number; incoming?: number; missing?: number }
  | { code: "licence_required"; pricingUrl: string }
  /** HTTP 429: too many requests at once; the wait is the server's (`Retry-After`). */
  | { code: "rate_limited" }
  | { code: "licence_other_space"; organisation?: string }
  | { code: "group_has_rules" | "role_has_rules"; usedIn?: UsedIn[] }
  | {
      code:
        | "licence_frozen"
        | "licence_invalid"
        | "licence_expired"
        | "licence_service_unreachable"
        | "licence_check_too_soon"
        | "role_above_you"
        | "person_above_you"
        | "permission_not_held"
        | "role_name_reserved"
        | "role_name_taken"
        | "beyond_guest_ceiling"
        | "make_them_a_member_first"
        | "no_self_role"
        | "manager_protected"
        | "group_from_directory"
        | "group_name_taken"
        | "group_name_reserved"
        | "group_name_invalid"
        | "manager_must_be_member"
        | "bad_expiry"
        | "guest_only"
        | "access_ended"
        | "not_ended"
        | "access_ended_for_good"
        | "base_role_not_allowed"
        | "not_in_space"
        | "too_many_people"
        | "cannot_grant"
        | "target_above_you"
        | "reservation_admins_only"
        | "guest_ceiling"
        | "audience_files_only"
        | "base_role_levels_only"
        | "permission_in_both"
        | "base_role_not_previewable"
        | "unknown_permission"
        | "wrong_family"
        | "preview_read_only"
        | "preview_unavailable";
    };

/** A place that names a group or a role in a rule; `hidden` when the caller cannot open it (no id, no name). */
export type UsedIn = {
  kind: "channel" | "file" | "calendar";
  id?: string;
  name?: string;
  hidden: boolean;
  /** The level the rule gives there; absent for a hidden place. */
  level?: AccessLevel;
  /** The folder a file or folder sits in, when it sits in one. */
  parentId?: string;
};

// --- Access to a channel, a file or a calendar (permissions lot 4) ---

/** What a resource's access dialog is about. A folder is a `file`. */
export type AccessKind = "channel" | "file" | "calendar";

/** The preset levels; `custom` is a rule that matches none of them (read only here). */
export type AccessLevel = "none" | "read" | "contribute" | "manage" | "custom";

/** Whom an entry is aimed at. `everyone` is the members, or the guests when `id` names `@guests`. */
export type AccessTargetKind = "everyone" | "role" | "group" | "user" | "audience";

/** A target to write: `id` is required for everything but `everyone` (absent means the members). */
export type AccessTargetRef = { kind: AccessTargetKind; id?: string };

/** A target as the dialog shows it. */
export type AccessTarget = { kind: AccessTargetKind; id?: string; name?: string; hidden: boolean };

/** A thing of the space, named: the folder an entry is inherited from, a file's parent. */
export type NamedRef = { kind: string; id?: string; name?: string; hidden: boolean };

/** How a `custom` entry differs from its nearest preset: `allow` (added), `deny`, or `unset`. */
export type AccessChange = { permission: string; state: "allow" | "deny" | "unset" };

/** One line of the dialog. */
export type AccessEntry = {
  /** The rule behind it; absent for an inherited line and for what the base roles grant. */
  id?: string;
  target: AccessTarget;
  level: AccessLevel;
  allow: string[];
  deny: string[];
  /** A group holding guests whose level reaches what a guest can never hold: its guests get less. */
  clamped: boolean;
  /** The target is a guest. */
  guest: boolean;
  /** The folder an inherited line comes from; never editable here. */
  inheritedFrom?: NamedRef;
  summary?: { nearest: AccessLevel; changes: AccessChange[] };
  /** The line is the legacy setting of the system role (`allowed_roles`, `write_access`). */
  viaLegacy: boolean;
  /** Who wrote the rule, and when; only for a reader who may edit, and absent for older rules. */
  setBy?: { id: string; name: string };
  setAt?: string;
};

/** Who has what on a resource, and what the caller may do about it. */
export type AccessView = {
  resource: { kind: AccessKind; id: string; name: string; parent?: NamedRef };
  /** A private channel. */
  private: boolean;
  /** An archived channel, or a trashed file. */
  archived: boolean;
  entries: AccessEntry[];
  may: {
    edit: boolean;
    /** Write rules that match no preset, and name custom roles (enterprise edition). */
    fine: boolean;
    /** The levels the caller may give here (`none` only to those who may reserve). */
    manageTargetLevels: AccessLevel[];
    /** The resource-level permissions of the family the caller holds here (`[]` for a non-editor). */
    held: string[];
    /** Why `edit` is false: `licence_required`, `licence_frozen` or `not_allowed`. */
    reason?: string;
  };
};

/** A role a step is about, and how the person holds it. */
export type WhyRole = { id: string; name: string; direct: boolean; viaGroups: { id: string; name: string }[] };

/** One step of the explanation, numbered in the order the engine took them. */
export type WhyStep = {
  n: number;
  /** `base`, `role`, `rule`, `private_lock`, `guest_ceiling`, `owner`, `author`, `archived`, `joined`... */
  kind: string;
  permission: string;
  effect: "granted" | "removed";
  role?: WhyRole;
  target?: AccessTarget;
  /** The folder, channel or calendar the rule sits on. */
  level?: NamedRef;
  /** For a `rule` step: the level of the rule behind it, as the access dialog reads it. */
  ruleLevel?: AccessLevel;
};

/** "Pourquoi ?": why a person has, or lacks, each permission of a resource. */
export type WhyView = {
  /** `roles`: every role the person holds beyond the base ones, whether or not a step names it. */
  person: { id: string; name: string; standing: "owner" | "member" | "guest" | string; roles: WhyRole[] };
  steps: WhyStep[];
  /** One line per permission of the resource's family; `reasonStep` is the `n` of the deciding step. */
  result: { permission: string; granted: boolean; reasonStep?: number }[];
};

/** "Voir en tant que": the role a space is being previewed as. */
export type Preview = { roleId: string; roleName: string; /** Seconds without activity before it ends (1800). */ idleSeconds?: number };

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
  /** RFC 3339 end of access the guest it admits will have; absent for no end date. */
  guestExpiresAt?: string;
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
  /** How many people have joined it. */
  memberCount?: number;
  /** The latest thing said or done in it, for a list's preview line. */
  lastMessage?: LastMessage;
  /**
   * What the caller may do here, by permission name (`files.manage`, `channel.manage`...), when the
   * instance announces the `permissions` feature. Absent from an older instance: fall back to the
   * role.
   */
  myPermissions?: string[];
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
  /** The others in the conversation (never the reader), for a group's faces and its size. */
  participantIds?: string[];
  /** How much this conversation notifies the signed-in user. */
  notify?: ConversationNotify;
  /**
   * Whether the signed-in user hid it from their list. A new message clears it on the server; the
   * one being read stays on screen anyway.
   */
  hidden?: boolean;
  /** The latest message, for the preview line of a conversation list; absent while nothing was said. */
  lastMessage?: LastMessage;
};

/**
 * The start of a conversation's latest message, who wrote it (the reader or not) and when (RFC 3339).
 *
 * In a channel where nothing was said since, it can be a notice instead (`notice`): the channel was
 * created, an event was shared. `excerpt` is then the notice's one detail, `author` who did it, and
 * `systemEvent` what happened when this client knows how to say it.
 */
export type LastMessage = {
  excerpt: string;
  mine: boolean;
  at: string;
  /** The author's display name; absent when the account is gone or a notice has nobody behind it. */
  author?: string;
  notice?: boolean;
  systemEvent?: SystemEvent;
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
  /** The file's own name (the description in `alt` may be anything), for the desktop's windows and titles. */
  name?: string;
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
  /** For a calendar card: its event as the reader sees it now (absent once they no longer see it). */
  eventCard?: EventCard;
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
   * A reply belongs in the feed only when sent to its channel too (`alsoInChannel`): the history
   * endpoint leaves the others out, and the live stream carries them like any other message, so
   * this is what tells them apart on arrival.
   */
  parentId?: string;
  /** A thread reply sent to its channel too: in the feed as well, under the thread it answers. */
  alsoInChannel?: boolean;
  /** For such a reply, the thread it answers: who started it and how it began. */
  threadRoot?: { id: string; authorName?: string; excerpt: string };
  replies?: number;
  /**
   * The last few people who answered in this message's thread, most recent first.
   *
   * Names, because that is what a row has to draw a face from (the roster holds the pictures, keyed
   * by name). Capped by the API; a client that shows fewer shows the first of them.
   */
  replyAuthors?: string[];
  /** When the thread was last answered (RFC 3339); absent without replies. */
  lastReplyAt?: string;
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
  | "channel_access_changed"
  | "calendar_event_posted"
  | "calendar_event_changed"
  | "calendar_event_cancelled";

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
  /** The folder holding the file (absent at the space root). */
  parentFolderId?: string;
  /** Who is editing the file in the office editor right now. */
  editors?: FileEditor[];
  /** The owner's account id: with the space role, it decides who may rename, move or delete. */
  ownerId?: string;
  /** Who wrote the current version (absent for a folder, or an import with no known author). */
  modifiedBy?: string;
  /** A folder's number of direct entries. */
  childCount?: number;
  /** Creation, RFC 3339. */
  createdAt?: string;
  mimeType?: string;
  versionNo?: number;
  /** Whether the person keeps it among their favourites. */
  starred?: boolean;
  /**
   * What the caller may do here, by permission name (`files.manage`, `channel.manage`...), when the
   * instance announces the `permissions` feature. Absent from an older instance: fall back to the
   * role.
   */
  myPermissions?: string[];
};

/** Someone editing a file in the office editor. */
export type FileEditor = { id: string; name: string };

/** What the office editor opens on this instance. */
export type OfficeCapabilities = {
  enabled: boolean;
  /** Extensions edited in place. */
  edit: string[];
  /** Extensions only shown. */
  view: string[];
  /** Extensions converted into an editable copy. */
  convert: string[];
  /** The editor's origin, which the client frames. */
  publicUrl?: string;
};

export type OfficeMode = "edit" | "view" | "convert";

/** An editing session, as the API opens it. */
export type OfficeSession = {
  file: SpaceFile;
  spaceId: string;
  /** The engine's address for the file, on the editor's own hostname. */
  url: string;
  accessToken: string;
  /** Token expiry, milliseconds since the epoch. */
  accessTokenTtl: number;
  mode: OfficeMode;
  /** The engine configuration posted with the token (JSON). */
  config: string;
  /** The member's display name, which seeds their default avatar. */
  memberName: string;
};

/** What a blank document is. */
export type BlankKind = "document" | "spreadsheet" | "presentation";
