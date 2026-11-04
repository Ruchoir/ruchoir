/**
 * What no rule, role or setting can ever give a guest, as the engine holds it
 * (`GUEST_CEILING` in `apps/api/src/permissions/system_roles.rs`), grouped into the five sentences
 * the screen says. A test reads the Rust list and fails when one side moves without the other.
 */
export const GUEST_CEILING = [
  "space.settings",
  "members.view",
  "members.invite",
  "members.manage",
  "roles.manage",
  "groups.manage",
  "audit.view",
  "channels.create",
  "channels.delete",
  "calendars.create",
  "files.trash.purge",
  "message.manage",
  "channel.members.manage",
  "channel.manage",
  "files.manage",
  "files.public_link",
  "calendar.manage",
] as const;

export type CeilingSentence = { id: "directory" | "people" | "create" | "moderate" | "settings"; permissions: string[] };

export const CEILING_SENTENCES: CeilingSentence[] = [
  { id: "directory", permissions: ["members.view"] },
  { id: "people", permissions: ["members.invite", "members.manage", "roles.manage", "channel.members.manage"] },
  { id: "create", permissions: ["channels.create", "channels.delete", "groups.manage", "calendars.create"] },
  { id: "moderate", permissions: ["message.manage", "channel.manage", "files.manage", "files.trash.purge", "calendar.manage"] },
  { id: "settings", permissions: ["files.public_link", "audit.view", "space.settings"] },
];

/**
 * What "Droits des invités" opens: the guests' role editor where a licence lets the space change it,
 * the read-only summary everywhere else (a frozen licence keeps what it set and changes nothing paid).
 */
export function rightsEntry(edition: "community" | "enterprise" | "frozen"): "editor" | "summary" {
  return edition === "enterprise" ? "editor" : "summary";
}

/**
 * The rights a space may tune for its guests, in the order the "Droits des invités" dialog lists
 * them. Everything else the guests' role holds (seeing, reading) is not offered as a switch.
 */
export const GUEST_TUNABLE = ["message.send", "message.react", "message.attach", "dm.start", "message.pin", "message.mention_all"] as const;

/**
 * The guests' role permissions once the tunable ones are set to `wanted`: the others are kept as they
 * are, and nothing from the ceiling can come in.
 */
export function guestRightsAfter(current: string[], wanted: ReadonlySet<string>): string[] {
  const tunable = new Set<string>(GUEST_TUNABLE);
  const kept = current.filter((p) => !tunable.has(p));
  const added = GUEST_TUNABLE.filter((p) => wanted.has(p));
  return [...kept, ...added];
}
