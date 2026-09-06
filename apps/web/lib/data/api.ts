/**
 * The fetch-backed implementation of the data seam.
 *
 * This is where the real Rust API is translated into the domain shapes the UI consumes
 * (`lib/data/types.ts`). Every function here is a thin, typed wrapper over {@link apiRequest}: it
 * calls one endpoint and maps its DTO (snake_case, UUIDs, RFC 3339 timestamps, raw byte sizes) into
 * the front shape (camel/display fields). The mock seam (`lib/data/index.ts`) is being replaced by
 * these, screen by screen, so the mapping lives in one auditable place.
 *
 * It covers auth (sign-in, registration, email verification, password reset and the second-factor
 * step-up), the space and channel lifecycle, and the space bootstrap, member profiles, the message operations, files, search,
 * the notification feed and the realtime channel (`connectRealtime`). Message ids are UUID strings;
 * `ApiMessage` is the front `Message` with that string id.
 */
import type { Presence } from "@/components/ds";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "./http";
import { getPasskeyAssertion, type PasskeyChallenge } from "@/lib/webauthn";
import type {
  Channel,
  ChannelType,
  DirectMessage,
  ImportSource,
  InlineImage,
  Message,
  MessageAttachment,
  MessageKind,
  Profile,
  Reaction,
  SpaceFile,
  Workspace,
} from "./types";

// --- Raw API DTOs (mirror the Rust structs; snake_case, as sent on the wire) ---

/** The signed-in user, from `POST /auth/login`, `POST /auth/register` and `GET /auth/session`. */
type UserSummaryDto = { id: string; email: string; display_name: string };

/** Alternative login outcome when a second factor is required (same 200 status as a success). */
type MfaRequiredDto = { mfa_required: true; methods: string[]; mfa_token: string };

type SpaceDto = { id: string; name: string; slug: string; role: string; members: number };

type ChannelDto = {
  id: string;
  name: string;
  type: string;
  topic?: string;
  imported?: string;
  favorite: boolean;
  member: boolean;
  unread: number;
};

type DirectMessageDto = {
  id: string;
  name: string;
  is_group: boolean;
  user_id?: string;
  bot: boolean;
  unread: number;
};

type PresenceDto = { user_id: string; presence: string };

type ReactionDto = { emoji: string; count: number; mine: boolean; users: string[] };

type AttachmentDto = {
  file_id: string;
  name: string;
  kind: string;
  size_bytes: number;
  mime_type?: string;
  version_id?: string;
  has_thumbnail: boolean;
  image_width?: number;
  image_height?: number;
  alt_text?: string;
};

type MessageDto = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  author_name: string | null;
  kind: string;
  body: string;
  system_event?: string;
  parent_message_id?: string;
  reply_count: number;
  imported: boolean;
  edited: boolean;
  deleted: boolean;
  pinned: boolean;
  saved: boolean;
  created_at: string;
  edited_at?: string;
  reactions: ReactionDto[];
  mentions: string[];
  attachments: AttachmentDto[];
};

type MessagePageDto = { messages: MessageDto[]; next_before?: string };

type UserProfileDto = {
  id: string;
  display_name: string;
  email: string;
  title?: string;
  pronouns?: string;
  timezone?: string;
  bio?: string;
  is_bot: boolean;
};

// --- Session / auth ---

/** The signed-in user in the shape the app shell holds it. */
export type SessionUser = { id: string; email: string; name: string };

/** Outcome of a login attempt: authenticated, or challenged for a second factor. */
export type LoginResult =
  | { kind: "authenticated"; user: SessionUser }
  | { kind: "mfa"; methods: MfaMethod[]; mfaToken: string };

function toSessionUser(dto: UserSummaryDto): SessionUser {
  return { id: dto.id, email: dto.email, name: dto.display_name };
}

/** `GET /auth/session`: the current user, or an {@link ApiError} 401 when no session is active. */
export async function getSession(signal?: AbortSignal): Promise<SessionUser> {
  return toSessionUser(await apiGet<UserSummaryDto>("/auth/session", signal));
}

/** `POST /auth/login`. Resolves to an authenticated user or an MFA challenge; throws on bad credentials. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const body = await apiPost<UserSummaryDto | MfaRequiredDto>("/auth/login", { email, password });
  if ("mfa_required" in body && body.mfa_required) {
    // Drop anything this client cannot complete, so the challenge screen never offers a dead option.
    const methods = body.methods.filter((m): m is MfaMethod => MFA_METHODS.includes(m as MfaMethod));
    return { kind: "mfa", methods, mfaToken: body.mfa_token };
  }
  return { kind: "authenticated", user: toSessionUser(body as UserSummaryDto) };
}

/** `POST /auth/logout`: end the current session. */
export async function logout(): Promise<void> {
  await apiPost<void>("/auth/logout");
}

// --- Registration, email verification and password reset ---

/**
 * `POST /auth/register`: create an account. No session is opened: the account starts unverified, the
 * API emails a verification link, and signing in is refused until the address is confirmed.
 */
export async function register(email: string, displayName: string, password: string): Promise<SessionUser> {
  const dto = await apiPost<UserSummaryDto>("/auth/register", {
    email,
    display_name: displayName,
    password,
  });
  return toSessionUser(dto);
}

/**
 * `POST /auth/verify-email/request`: send (or resend) the verification link. Always resolves, whether
 * or not the address has an account, so the response never reveals who is registered.
 */
export async function requestEmailVerification(email: string): Promise<void> {
  await apiPost<void>("/auth/verify-email/request", { email });
}

/** `POST /auth/verify-email/confirm`: activate the account behind an emailed token (single use). */
export async function confirmEmailVerification(token: string): Promise<void> {
  await apiPost<void>("/auth/verify-email/confirm", { token });
}

/** `POST /auth/password-reset/request`: email a reset link. Always resolves (no account enumeration). */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiPost<void>("/auth/password-reset/request", { email });
}

/**
 * `POST /auth/password-reset/confirm`: set a new password from an emailed token. The server drops
 * every existing session for that account, so the user signs in again with the new password.
 */
export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  await apiPost<void>("/auth/password-reset/confirm", { token, password });
}

// --- Second factor at sign-in ---

/**
 * The second factors an account can complete, as listed by an {@link LoginResult} MFA challenge.
 * Unknown values are ignored by the screen rather than rendered as an unusable option.
 */
export type MfaMethod = "totp" | "passkey" | "recovery";

/** The known {@link MfaMethod} values, in the order the challenge screen prefers them. */
const MFA_METHODS: MfaMethod[] = ["totp", "passkey", "recovery"];

/** `POST /auth/mfa/totp/verify`: answer the pending challenge with an authenticator code. */
export async function verifyTotp(mfaToken: string, code: string): Promise<SessionUser> {
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/totp/verify", { mfa_token: mfaToken, code });
  return toSessionUser(dto);
}

/** `POST /auth/mfa/recovery/verify`: answer the pending challenge with a single-use recovery code. */
export async function verifyRecoveryCode(mfaToken: string, code: string): Promise<SessionUser> {
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/recovery/verify", { mfa_token: mfaToken, code });
  return toSessionUser(dto);
}

/**
 * Answer the pending challenge with a passkey: fetch the WebAuthn challenge, have the authenticator
 * sign it, and post the assertion back (`/auth/mfa/passkey/authenticate/{start,finish}`). Resolves to
 * the signed-in user; the session cookie is set on the finish response like any other sign-in.
 */
export async function verifyPasskey(mfaToken: string): Promise<SessionUser> {
  const challenge = await apiPost<PasskeyChallenge>("/auth/mfa/passkey/authenticate/start", {
    mfa_token: mfaToken,
  });
  const credential = await getPasskeyAssertion(challenge);
  const dto = await apiPost<UserSummaryDto>("/auth/mfa/passkey/authenticate/finish", {
    mfa_token: mfaToken,
    credential,
  });
  return toSessionUser(dto);
}

// --- Space bootstrap (workspaces, channels, DMs, presence, profiles) ---

function toWorkspace(dto: SpaceDto): Workspace {
  return { id: dto.id, name: dto.name, members: dto.members };
}

/** `GET /me/spaces`: the workspaces the caller belongs to. The SPA's entry point. */
export async function getWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  const spaces = await apiGet<SpaceDto[]>("/me/spaces", signal);
  return spaces.map(toWorkspace);
}

function toChannel(dto: ChannelDto): Channel {
  return {
    id: dto.id,
    name: dto.name,
    fav: dto.favorite,
    unread: dto.unread,
    type: (["public", "private", "archived"].includes(dto.type) ? dto.type : "public") as ChannelType,
    topic: dto.topic,
    imported: toImportSource(dto.imported),
    member: dto.member,
  };
}

/**
 * `POST /spaces`: create a space owned by the caller. It comes back with a starting channel, so the
 * caller lands on something rather than on an empty shell.
 */
export async function createSpace(name: string): Promise<Workspace> {
  return toWorkspace(await apiPost<SpaceDto>("/spaces", { name }));
}

/** `GET /spaces/{id}/channels`: the channels the caller can see in a space. */
export async function getChannels(spaceId: string, signal?: AbortSignal): Promise<Channel[]> {
  const channels = await apiGet<ChannelDto[]>(`/spaces/${spaceId}/channels`, signal);
  return channels.map(toChannel);
}

/**
 * `POST /spaces/{id}/channels`: create a channel, owned by the caller. The server normalises the
 * name into a handle (lowercase, accents folded, dashes), so the channel comes back under the name
 * it will keep, which may differ from what was typed.
 */
export async function createChannel(
  spaceId: string,
  channel: { name: string; type: ChannelType; topic?: string },
): Promise<Channel> {
  const dto = await apiPost<ChannelDto>(`/spaces/${spaceId}/channels`, {
    name: channel.name,
    type: channel.type,
    topic: channel.topic,
  });
  return toChannel(dto);
}

/**
 * `PATCH /channels/{id}`: rename a channel, set its topic, or change its visibility. Archiving is
 * `type: "archived"`, which makes the channel read-only without deleting anything.
 */
export async function updateChannel(
  channelId: string,
  patch: { name?: string; type?: ChannelType; topic?: string },
): Promise<Channel> {
  const dto = await apiPatch<ChannelDto>(`/channels/${channelId}`, {
    name: patch.name,
    type: patch.type,
    topic: patch.topic,
  });
  return toChannel(dto);
}

/** `PUT /channels/{id}/membership`: join a public channel. Idempotent. */
export async function joinChannel(channelId: string): Promise<void> {
  await apiPut<void>(`/channels/${channelId}/membership`);
}

/** `DELETE /channels/{id}/membership`: leave a channel. Only the caller's membership is removed. */
export async function leaveChannel(channelId: string): Promise<void> {
  await apiDelete<void>(`/channels/${channelId}/membership`);
}

function toDirectMessage(dto: DirectMessageDto): DirectMessage {
  // The DM list carries no presence (it is volatile); it is overlaid from `getSpacePresence` and
  // realtime events, keyed by the counterpart's user id. Default to offline until that arrives.
  return {
    id: dto.id,
    name: dto.name,
    presence: "offline",
    unread: dto.unread,
    bot: dto.bot || undefined,
    userId: dto.user_id,
  };
}

/** `GET /spaces/{id}/dms`: the caller's direct-message conversations in a space. */
export async function getDirectMessages(spaceId: string, signal?: AbortSignal): Promise<DirectMessage[]> {
  const dms = await apiGet<DirectMessageDto[]>(`/spaces/${spaceId}/dms`, signal);
  return dms.map(toDirectMessage);
}

/** `GET /spaces/{id}/presence`: the current presence of the space's members, keyed by user id. */
export async function getSpacePresence(spaceId: string, signal?: AbortSignal): Promise<Record<string, Presence>> {
  const rows = await apiGet<PresenceDto[]>(`/spaces/${spaceId}/presence`, signal);
  const out: Record<string, Presence> = {};
  for (const row of rows) out[row.user_id] = toPresence(row.presence);
  return out;
}

/** `PUT /me/presence`: set the caller's manual presence override, then the server broadcasts it. */
export async function setMyPresence(presence: Presence): Promise<void> {
  const manual =
    presence === "online" ? "active" : presence === "busy" ? "dnd" : presence === "away" ? "away" : "invisible";
  await apiPut<void>("/me/presence", { manual_presence: manual });
}

/**
 * `GET /users/{id}`: a member's profile. Presence and local time are not carried by the endpoint:
 * presence is overlaid by the caller from the space presence map, and the local time is derived from
 * the timezone here so the profile card can render it.
 */
export async function getUserProfile(userId: string, signal?: AbortSignal): Promise<Profile> {
  const dto = await apiGet<UserProfileDto>(`/users/${userId}`, signal);
  return {
    name: dto.display_name,
    role: dto.title ?? "Membre",
    presence: "offline",
    email: dto.email,
    timezone: dto.timezone ?? "Europe/Paris",
    localTime: localTimeIn(dto.timezone),
    pronouns: dto.pronouns,
    bio: dto.bio,
    bot: dto.is_bot || undefined,
  };
}

type MemberDto = { user_id: string; display_name: string; title?: string; role: string; is_bot: boolean };

/** A space member as the app holds it. Presence is overlaid separately (by user id). */
export type Member = { userId: string; name: string; role: string; title?: string; bot: boolean };

/** `GET /spaces/{id}/members`: the members of a space (member list, mentions, people search). */
export async function getSpaceMembers(spaceId: string, signal?: AbortSignal): Promise<Member[]> {
  const rows = await apiGet<MemberDto[]>(`/spaces/${spaceId}/members`, signal);
  return rows.map((m) => ({ userId: m.user_id, name: m.display_name, role: m.role, title: m.title, bot: m.is_bot }));
}

/** `POST /spaces/{id}/dm`: open (or fetch) a direct message with a set of users; returns its id. */
export async function createDm(spaceId: string, userIds: string[]): Promise<string> {
  const ref = await apiPost<{ id: string }>(`/spaces/${spaceId}/dm`, { user_ids: userIds });
  return ref.id;
}

/** `PATCH /users/me`: update the caller's own profile; absent fields are unchanged, blank clears. */
export async function updateMyProfile(patch: {
  displayName?: string;
  title?: string;
  pronouns?: string;
  bio?: string;
}): Promise<Profile> {
  const dto = await apiPatch<UserProfileDto>("/users/me", {
    display_name: patch.displayName,
    title: patch.title,
    pronouns: patch.pronouns,
    bio: patch.bio,
  });
  return {
    name: dto.display_name,
    role: dto.title ?? "Membre",
    presence: "offline",
    email: dto.email,
    timezone: dto.timezone ?? "Europe/Paris",
    localTime: localTimeIn(dto.timezone),
    pronouns: dto.pronouns,
    bio: dto.bio,
    bot: dto.is_bot || undefined,
  };
}

// --- Messages ---

/**
 * A message as this seam returns it: the front {@link Message} shape but with the real string id.
 * The UI's `Message.id` is still numeric (the mock seam); the AppRoot wiring slice flips it to
 * `string`, at which point `ApiMessage` and `Message` coincide and this alias can be dropped. Keeping
 * it as an `Omit`-based alias means it tracks every other change to `Message` in the meantime.
 */
export type ApiMessage = Omit<Message, "id"> & { id: string };

/** A page of a conversation's feed, oldest-last, with a cursor for the previous (older) page. */
export type MessagePage = { messages: ApiMessage[]; nextBefore?: string };

/** `GET /conversations/{id}/messages`: a page of a conversation's feed (newest last). */
export async function getChannelMessages(
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (opts.before) params.set("before", opts.before);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  const page = await apiGet<MessagePageDto>(
    `/conversations/${conversationId}/messages${query ? `?${query}` : ""}`,
    signal,
  );
  return { messages: page.messages.map(toMessage), nextBefore: page.next_before };
}

/** `POST /conversations/{id}/messages`: post a message (optionally a threaded reply). */
export async function sendMessage(
  conversationId: string,
  body: string,
  opts: { attachments?: string[]; parentMessageId?: string } = {},
): Promise<ApiMessage> {
  const dto = await apiPost<MessageDto>(`/conversations/${conversationId}/messages`, {
    body,
    attachments: opts.attachments ?? [],
    parent_message_id: opts.parentMessageId,
  });
  return toMessage(dto);
}

/** `PATCH /messages/{id}`: edit a message's body. */
export async function editMessage(messageId: string, body: string): Promise<ApiMessage> {
  return toMessage(await apiPatch<MessageDto>(`/messages/${messageId}`, { body }));
}

/** `DELETE /messages/{id}`: soft-delete a message, returning its tombstone. */
export async function deleteMessage(messageId: string): Promise<ApiMessage> {
  return toMessage(await apiDelete<MessageDto>(`/messages/${messageId}`));
}

/** `GET /messages/{id}/replies`: the messages in a thread, oldest first. */
export async function getReplies(messageId: string, signal?: AbortSignal): Promise<ApiMessage[]> {
  const replies = await apiGet<MessageDto[]>(`/messages/${messageId}/replies`, signal);
  return replies.map(toMessage);
}

/** `PUT /messages/{id}/reactions/{emoji}`: add the caller's reaction. */
export async function addReaction(messageId: string, emoji: string): Promise<void> {
  await apiPut<void>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

/** `DELETE /messages/{id}/reactions/{emoji}`: remove the caller's reaction. */
export async function removeReaction(messageId: string, emoji: string): Promise<void> {
  await apiDelete<void>(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

/** `PUT /conversations/{id}/read`: advance the caller's read cursor to a message. */
export async function setReadCursor(conversationId: string, lastReadMessageId: string): Promise<void> {
  await apiPut<void>(`/conversations/${conversationId}/read`, { last_read_message_id: lastReadMessageId });
}

/** `PUT|DELETE /messages/{id}/save`: bookmark or un-bookmark a message. */
export async function setMessageSaved(messageId: string, saved: boolean): Promise<void> {
  if (saved) await apiPut<void>(`/messages/${messageId}/save`);
  else await apiDelete<void>(`/messages/${messageId}/save`);
}

/** `PUT|DELETE /channels/{channelId}/pins/{messageId}`: pin or unpin a message in a channel. */
export async function setMessagePinned(channelId: string, messageId: string, pinned: boolean): Promise<void> {
  if (pinned) await apiPut<void>(`/channels/${channelId}/pins/${messageId}`);
  else await apiDelete<void>(`/channels/${channelId}/pins/${messageId}`);
}

// --- Mapping helpers ---

function toMessage(dto: MessageDto): ApiMessage {
  const { attachment, image } = splitAttachments(dto.attachments);
  return {
    id: dto.id,
    kind: (dto.kind === "system" ? "system" : "message") as MessageKind,
    author: dto.author_name ?? "",
    authorId: dto.author_id ?? undefined,
    time: formatTimestamp(dto.created_at),
    body: dto.body,
    systemIcon: dto.kind === "system" ? iconForSystemEvent(dto.system_event) : undefined,
    attachment,
    image,
    reactions: dto.reactions.length > 0 ? dto.reactions.map(toReaction) : undefined,
    replies: dto.reply_count > 0 ? dto.reply_count : undefined,
    imported: dto.imported || undefined,
    pinned: dto.pinned || undefined,
    edited: dto.edited || undefined,
    deleted: dto.deleted || undefined,
    saved: dto.saved || undefined,
  };
}

function toReaction(dto: ReactionDto): Reaction {
  return { emoji: dto.emoji, count: dto.count, mine: dto.mine || undefined, users: dto.users };
}

/**
 * Fold an attachment list into the UI's single `attachment` + single inline `image`. The first
 * image-kind attachment with intrinsic dimensions becomes the inline image; the first non-image
 * becomes the file attachment. This matches what the exploration renders; richer multi-attachment
 * layout is a later concern.
 */
function splitAttachments(attachments: AttachmentDto[]): {
  attachment?: MessageAttachment;
  image?: InlineImage;
} {
  let attachment: MessageAttachment | undefined;
  let image: InlineImage | undefined;
  for (const a of attachments) {
    if (!image && a.kind === "image" && a.image_width && a.image_height) {
      image = { alt: a.alt_text ?? a.name, width: a.image_width, height: a.image_height };
    } else if (!attachment) {
      attachment = { name: a.name, size: formatSize(a.size_bytes), kind: attachmentIcon(a.kind) };
    }
  }
  return { attachment, image };
}

/** Map an API import-source string (free text, e.g. "slack") to the front's capitalized enum. */
function toImportSource(source?: string): ImportSource | undefined {
  if (!source) return undefined;
  const known: Record<string, ImportSource> = {
    nextcloud: "Nextcloud",
    slack: "Slack",
    mattermost: "Mattermost",
    ruchoir: "Ruchoir",
  };
  return known[source.toLowerCase()];
}

/** Map the API presence vocabulary (`active|away|dnd|offline`) to the DS presence dot. */
function toPresence(presence: string): Presence {
  switch (presence) {
    case "active":
      return "online";
    case "dnd":
      return "busy";
    case "away":
      return "away";
    default:
      return "offline";
  }
}

/** Pick a DS icon name for a system message from its event discriminator. */
function iconForSystemEvent(event?: string): string {
  switch (event) {
    case "member_joined":
    case "channel_joined":
      return "user-plus";
    case "member_left":
    case "channel_left":
      return "user-minus";
    default:
      return "info";
  }
}

/** Map an attachment kind to the DS file icon the UI expects. */
function attachmentIcon(kind: string): string {
  switch (kind) {
    case "file-text":
    case "file-spreadsheet":
    case "folder":
      return kind;
    default:
      return "file";
  }
}

/** Format a byte count as a French display size ("248 Ko", "3,4 Mo"). */
function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${units[unit]}`;
}

/**
 * Format an RFC 3339 timestamp as the short human label the feed shows: the time for today, "Hier,
 * HH:MM" for yesterday, and a "j mois" date beyond that. Locale-French, the app's only locale today.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Hier, ${time}`;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Current local time in a timezone, as "HH:MM"; falls back to the local zone on an invalid name. */
function localTimeIn(timezone?: string): string {
  try {
    return new Date().toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone || undefined,
    });
  } catch {
    return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
}

// --- Notifications ---

type NotificationDto = {
  id: string;
  kind: string;
  conversation_id: string;
  message_id: string;
  actor_id?: string;
  actor_name?: string;
  preview: string;
  created_at: string;
  read: boolean;
};

type NotificationPageDto = {
  notifications: NotificationDto[];
  next_before?: string;
  unread_count: number;
};

/** A notification as this seam returns it. `label`/`isDm` are resolved by the caller (they need the
 * live channel and DM lists, which the seam does not hold). */
export type ApiNotification = {
  id: string;
  kind: "mention" | "reply" | "dm";
  conversationId: string;
  messageId: string;
  actor: string;
  preview: string;
  time: string;
  read: boolean;
};

/** A page of the notification inbox, newest first, with the caller's total unread count. */
export type NotificationFeed = { notifications: ApiNotification[]; nextBefore?: string; unreadCount: number };

function toApiNotification(dto: NotificationDto): ApiNotification {
  const kind = dto.kind === "mention" || dto.kind === "reply" || dto.kind === "dm" ? dto.kind : "mention";
  return {
    id: dto.id,
    kind,
    conversationId: dto.conversation_id,
    messageId: dto.message_id,
    actor: dto.actor_name ?? "",
    preview: dto.preview,
    time: formatTimestamp(dto.created_at),
    read: dto.read,
  };
}

/** `GET /notifications`: the caller's in-app notification inbox. */
export async function getNotifications(
  opts: { unread?: boolean; before?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<NotificationFeed> {
  const params = new URLSearchParams();
  if (opts.unread) params.set("unread", "true");
  if (opts.before) params.set("before", opts.before);
  if (opts.limit) params.set("limit", String(opts.limit));
  const query = params.toString();
  const page = await apiGet<NotificationPageDto>(`/notifications${query ? `?${query}` : ""}`, signal);
  return {
    notifications: page.notifications.map(toApiNotification),
    nextBefore: page.next_before,
    unreadCount: page.unread_count,
  };
}

/** `PUT /notifications/{id}/read`: mark one notification read. */
export async function markNotificationRead(id: string): Promise<void> {
  await apiPut<void>(`/notifications/${id}/read`);
}

/** `PUT /notifications/read`: mark every notification read. */
export async function markAllNotificationsRead(): Promise<void> {
  await apiPut<void>("/notifications/read");
}

// --- Search ---

type FileHitDto = { id: string; name: string; kind: string };
type SearchResultsDto = { messages: MessageDto[]; files: FileHitDto[] };

/** A file matched by search: enough to render a result row and open it. */
export type FileHit = { id: string; name: string; kind: string };
/** A message matched by search, carrying its conversation id so a click can navigate to it. */
export type SearchMessage = ApiMessage & { conversationId: string };
/** Combined search results: matching messages and file names the caller can see. */
export type SearchHits = { messages: SearchMessage[]; files: FileHit[] };

/** `GET /search`: full-text search over the space's messages and file names. */
export async function search(spaceId: string, query: string, signal?: AbortSignal): Promise<SearchHits> {
  const params = new URLSearchParams({ q: query, space_id: spaceId, type: "all" });
  const results = await apiGet<SearchResultsDto>(`/search?${params.toString()}`, signal);
  return {
    messages: results.messages.map((m) => ({ ...toMessage(m), conversationId: m.conversation_id })),
    files: results.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
  };
}

// --- Files ---

type FileDto = {
  id: string;
  space_id: string;
  name: string;
  kind: string;
  is_folder: boolean;
  parent_folder_id?: string;
  size_bytes: number;
  owner_id?: string;
  owner_name?: string;
  mime_type?: string;
  version_id?: string;
  version_no?: number;
  has_thumbnail: boolean;
  image_width?: number;
  image_height?: number;
  imported: boolean;
  imported_source?: string;
  created_at: string;
  updated_at: string;
};

type FolderListingDto = {
  folder_id?: string;
  breadcrumb: { id: string; name: string }[];
  entries: FileDto[];
};

/** A resolved folder view: its id (absent at root), breadcrumb trail and entries as UI files. */
export type FolderListing = {
  folderId?: string;
  breadcrumb: { id: string; name: string }[];
  entries: SpaceFile[];
};

function toSpaceFileKind(kind: string, isFolder: boolean): SpaceFile["kind"] {
  if (isFolder || kind === "folder") return "folder";
  if (kind === "file-text" || kind === "file-spreadsheet") return kind;
  return "file";
}

function toSpaceFile(dto: FileDto): SpaceFile {
  return {
    id: dto.id,
    name: dto.name,
    kind: toSpaceFileKind(dto.kind, dto.is_folder),
    size: dto.is_folder ? "" : formatSize(dto.size_bytes),
    by: dto.owner_name ?? "",
    when: formatTimestamp(dto.updated_at),
    // The connector a migrated file came from; native files (and unknown connectors) read as Ruchoir.
    source: toImportSource(dto.imported_source) ?? "Ruchoir",
    version: dto.version_no != null ? `v${dto.version_no}` : "",
    imported: dto.imported,
  };
}

/** `GET /spaces/{id}/files`: the entries of a folder (or the space root when `folderId` is absent). */
export async function getFolder(
  spaceId: string,
  folderId?: string,
  signal?: AbortSignal,
): Promise<FolderListing> {
  const query = folderId ? `?folder=${folderId}` : "";
  const listing = await apiGet<FolderListingDto>(`/spaces/${spaceId}/files${query}`, signal);
  return {
    folderId: listing.folder_id,
    breadcrumb: listing.breadcrumb,
    entries: listing.entries.map(toSpaceFile),
  };
}

/** `POST /spaces/{id}/folders`: create a folder (at the root, or inside `parentId`). */
export async function createFolder(spaceId: string, name: string, parentId?: string): Promise<SpaceFile> {
  const dto = await apiPost<FileDto>(`/spaces/${spaceId}/folders`, {
    name,
    parent_folder_id: parentId,
  });
  return toSpaceFile(dto);
}

/** `POST /spaces/{id}/files`: upload a file (multipart) into the root or a folder. */
export async function uploadFile(spaceId: string, file: File, parentId?: string): Promise<SpaceFile> {
  const form = new FormData();
  form.append("file", file);
  if (parentId) form.append("parent_folder_id", parentId);
  // Multipart: let the browser set the boundary, so this call does not go through the JSON client.
  const res = await fetch(`/api/v1/spaces/${spaceId}/files`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
  return toSpaceFile((await res.json()) as FileDto);
}

/** The same-origin URL that streams a file's bytes (the API proxies the object store). */
export function fileDownloadUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/download`;
}

/** The same-origin URL for a file's inline preview bytes. */
export function filePreviewUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/preview`;
}

// --- Realtime (WebSocket) ---

/** A decoded server-to-client realtime frame. `payload` shape depends on `type`. */
type RealtimeEnvelope = { v: number; type: string; conversation_id?: string; payload: unknown };

/** A reaction delta carried by a `reaction.added` / `reaction.removed` event. */
export type RealtimeReaction = { messageId: string; emoji: string; userId: string; added: boolean };

/** Handlers the app wires to live events. All optional; unhandled event types are ignored. */
export type RealtimeHandlers = {
  onMessageCreated?: (conversationId: string, message: ApiMessage) => void;
  onMessageUpdated?: (conversationId: string, message: ApiMessage) => void;
  onMessageDeleted?: (conversationId: string, message: ApiMessage) => void;
  onReaction?: (conversationId: string, reaction: RealtimeReaction) => void;
  onPinned?: (conversationId: string, messageId: string, pinned: boolean) => void;
  onPresence?: (userId: string, presence: Presence) => void;
  onNotification?: (notification: ApiNotification) => void;
  onTyping?: (conversationId: string, userId: string) => void;
};

/** A live realtime connection: close it on teardown, and signal typing over it. */
export type RealtimeConnection = { close: () => void; sendTyping: (conversationId: string) => void };

/**
 * Open the realtime WebSocket and dispatch decoded events to `handlers`. The socket authenticates
 * from the same-origin session cookie on the upgrade (no token), reconnects with a capped backoff
 * after an unexpected close, and sends a periodic ping so a quiet connection stays counted as online.
 * All mutations still go through REST; this socket only receives pushes and sends typing/ping.
 */
export function connectRealtime(handlers: RealtimeHandlers): RealtimeConnection {
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectDelay = 1000;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const url = () => {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}/api/v1/realtime/ws`;
  };

  const dispatch = (env: RealtimeEnvelope) => {
    const conv = env.conversation_id ?? "";
    const payload = env.payload as Record<string, unknown>;
    switch (env.type) {
      case "message.created":
        handlers.onMessageCreated?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "message.updated":
        handlers.onMessageUpdated?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "message.deleted":
        handlers.onMessageDeleted?.(conv, toMessage(payload as unknown as MessageDto));
        break;
      case "reaction.added":
      case "reaction.removed":
        handlers.onReaction?.(conv, {
          messageId: String(payload.message_id),
          emoji: String(payload.emoji),
          userId: String(payload.user_id),
          added: env.type === "reaction.added",
        });
        break;
      case "message.pinned":
      case "message.unpinned":
        handlers.onPinned?.(conv, String(payload.message_id), env.type === "message.pinned");
        break;
      case "presence":
        handlers.onPresence?.(String(payload.user_id), toPresence(String(payload.presence)));
        break;
      case "notification.created":
        handlers.onNotification?.(toApiNotification(payload as unknown as NotificationDto));
        break;
      case "typing":
        handlers.onTyping?.(conv, String(payload.user_id));
        break;
      default:
        // Unhandled event types (saved, read cursor) are ignored for now.
        break;
    }
  };

  const connect = () => {
    if (closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      reconnectDelay = 1000;
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 25000);
    };
    ws.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data as string) as RealtimeEnvelope);
      } catch {
        // Ignore an unparseable frame rather than tearing the connection down.
      }
    };
    ws.onclose = () => {
      clearInterval(pingTimer);
      if (!closed) scheduleReconnect();
    };
    ws.onerror = () => {
      // The close handler drives reconnection; nothing extra to do here.
    };
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };

  connect();

  return {
    close: () => {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      socket?.close();
    },
    sendTyping: (conversationId: string) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "typing", conversation_id: conversationId }));
      }
    },
  };
}
