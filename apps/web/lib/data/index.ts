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
 * Live member roster for the space on screen, read synchronously by the `@`-mention autocomplete
 * and a couple of dialogs rather than threaded through props.
 *
 * It is a *store*, not a variable, and the difference is the whole point: readers subscribe, so
 * they see the space they are in. Read as a plain variable it froze at whatever was loaded when the
 * reader first rendered, and the composer went on offering the people of the first space opened,
 * in every space after it. Names of colleagues who are not in the room is not a cosmetic defect.
 *
 * Empty until a space is loaded, and emptied again while switching, because the people of the space
 * being left are not a usable approximation of the people of the space being entered.
 */
const NO_MEMBERS: MemberRecord[] = [];

let liveMembers: MemberRecord[] = NO_MEMBERS;

const directoryListeners = new Set<() => void>();

/**
 * Replace the roster with the members of the space on screen.
 *
 * The presence map keyed by display name goes with it: it describes these people, and a name from
 * another space surviving here is the same leak by a different route.
 */
export function setChannelMembers(members: MemberRecord[]): void {
  liveMembers = members;
  for (const name of Object.keys(presenceOverride)) delete presenceOverride[name];
  for (const listener of directoryListeners) listener();
}

/** Subscribe to roster changes, for `useSyncExternalStore`. */
export function subscribeToDirectory(onChange: () => void): () => void {
  directoryListeners.add(onChange);
  return () => {
    directoryListeners.delete(onChange);
  };
}

/**
 * Channel members (for mention autocomplete and member dialogs).
 *
 * The same array is returned until it is actually replaced, which is what lets it be a snapshot:
 * a fresh array on every call would loop a subscriber forever.
 */
export function getChannelMembers(): MemberRecord[] {
  return liveMembers;
}

/** The snapshot for a render with no browser behind it: nobody, rather than someone stale. */
export function getServerDirectory(): MemberRecord[] {
  return NO_MEMBERS;
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

/**
 * Every spelling a mention can take, for the renderer to highlight.
 *
 * Three per member: the display name, its first word, and the name without its spaces. They are the
 * same three the server resolves a handle against, and the composer writes one of them. Listing
 * only the full name left "@Théo" as plain text even though it had reached Théo, which is the kind
 * of disagreement between what the server did and what the screen shows that makes a feature feel
 * unreliable.
 *
 * The renderer prefers the longest match, so a full name still wins over its first word.
 */
export function getMentionNames(): string[] {
  // The two room-wide handles are mentions as much as a name is, and are highlighted like one.
  // Listed in both languages because the server accepts both.
  const names = new Set<string>(["canal", "ici", "channel", "here", "tous", "everyone", "all"]);
  for (const member of liveMembers) {
    names.add(member.name);
    const words = member.name.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      names.add(words[0]);
      names.add(words.join(""));
    }
  }
  return [...names];
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
  PresenceChoice,
  Profile,
  Reaction,
  SpaceFile,
  SpaceFileKind,
  SystemEvent,
  Workspace,
} from "./types";
