/**
 * The data seam: a thin synchronous bridge for the few pieces of domain state that many components
 * read without prop threading (the current user, the member roster, per-name presence).
 *
 * The app populates these registries from the real API (session, `GET /spaces/{id}/members`, presence
 * snapshot and realtime events); everything else is fetched directly through `lib/data/api.ts`. This
 * module holds no fixture data.
 */
import type { Presence } from "@/components/ds";

// --- Current user ---

let currentUserName: string | null = null;

/** Set the current user's display name from the real session. */
export function setCurrentUser(name: string): void {
  currentUserName = name;
}

/** The signed-in user's display name (empty before the session resolves). */
export function getCurrentUser(): { name: string } {
  return { name: currentUserName ?? "" };
}

// --- Presence (by display name) ---

/**
 * Per-name presence, pushed by the app from the live presence map so components that only have a
 * display name (the notification center, side panels) can render a presence dot. Absent names read as
 * offline. The primary, reactive presence path is the presence map threaded through props.
 */
const presenceOverride: Record<string, Presence> = {};

export function setUserPresence(name: string, presence: Presence): void {
  presenceOverride[name] = presence;
}

/** A user's presence, by display name; unknown names are offline. */
export function getPresence(name: string): Presence {
  return presenceOverride[name] ?? "offline";
}

// --- Member roster ---

type MemberRecord = { name: string; presence: Presence; bot?: boolean; avatar?: string };

/**
 * Live member roster, populated once the real space members are loaded. Kept here (not threaded
 * through props) because the `@`-mention autocomplete and a couple of dialogs read it synchronously.
 * Empty until loaded.
 */
let liveMembers: MemberRecord[] = [];

/** Replace the member roster with the real space members. */
export function setChannelMembers(members: MemberRecord[]): void {
  liveMembers = members;
}

/** Channel members (for mention autocomplete and member dialogs). */
export function getChannelMembers(): MemberRecord[] {
  return liveMembers;
}

/**
 * A member's uploaded avatar, by display name; `undefined` means the generated one.
 *
 * Sibling of {@link getPresence}, and there for the same reason: a message row, a notification and a
 * search hit hold an author's name and nothing else, so without a lookup by name they would all draw
 * the generated avatar however carefully a photo had been threaded through the roster.
 */
export function getAvatar(name: string): string | undefined {
  return liveMembers.find((m) => m.name === name)?.avatar;
}

/** Names that can be @mentioned in the current channel. */
export function getMentionNames(): string[] {
  return liveMembers.map((m) => m.name);
}

export type {
  Channel,
  CreatedInvitation,
  ChannelType,
  DirectMessage,
  ImportSource,
  InlineImage,
  Invitation,
  InvitationPreview,
  LinkPreview,
  Message,
  MessageAttachment,
  MessageKind,
  Profile,
  Reaction,
  SpaceFile,
  SpaceFileKind,
  Workspace,
} from "./types";
