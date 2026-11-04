/**
 * The sections of a space's settings (mockup frame 1), which of them a person reaches, and the line
 * under each title. Pure: lines are i18n keys with their variables, never French, and the screen
 * translates them. Kept free of React so Node tests it.
 *
 * On an instance without the permissions (`supported` false) the settings keep what they always were:
 * General for everyone, Members for the owner and the admins (`canAdminister`).
 */
import { rightsOf, type spaceGates } from "@ruchoir/client/permissionsLogic";
import type { Workspace } from "@ruchoir/client";

import { canAdminister } from "./spaceRoles.ts";

export type SectionKey = "general" | "members" | "roles" | "groups" | "audit" | "licence";

/** One piece of a line: a dictionary key and its variables. Pieces are joined with " · ". */
export type LinePart = { key: string; vars?: Record<string, number | string> };

export type Section = { key: SectionKey; line: LinePart[] };

type Gates = ReturnType<typeof spaceGates>;
type SpaceView = Pick<Workspace, "role" | "members" | "edition"> & Partial<Pick<Workspace, "myPermissions" | "licence">>;

/** What the screens that load them know, for the lines; absent counts give the plain wording. */
export type Counts = { people?: number; guests?: number; roles?: number; customRoles?: number; groups?: number };

/** Sections whose screen exists. Each later task flips its own to true. */
export type Ready = Record<"roles" | "groups" | "audit" | "licence", boolean>;
export const READY: Ready = { roles: false, groups: false, audit: false, licence: false };

export function sectionsFor(
  gates: Gates,
  supported: boolean,
  space: SpaceView | null | undefined,
  opts: { ready?: Ready; counts?: Counts; licences?: boolean } = {},
): Section[] {
  if (!space) return [];
  const { ready = READY, counts = {}, licences = true } = opts;
  const out: Section[] = [];
  const add = (key: SectionKey, line: LinePart[]) => out.push({ key, line });
  const members = (): LinePart[] => [
    { key: "details.membersCount", vars: { count: counts.people ?? space.members } },
    ...(counts.guests ? [{ key: "event.invited", vars: { count: counts.guests } }] : []),
  ];

  if (!supported) {
    add("general", [{ key: "spaceSections.generalLine" }]);
    if (canAdminister(space.role)) add("members", members());
    return out;
  }

  const rights = rightsOf(space);
  const has = (p: string) => rights.includes(p);
  if (space.role === "owner" || has("space.settings")) add("general", [{ key: "spaceSections.generalLine" }]);
  if (has("members.view") || gates.managePeople || gates.invite) add("members", members());
  if (ready.roles && gates.managePeople) {
    add(
      "roles",
      counts.roles === undefined
        ? [{ key: "spaceSections.rolesLine" }]
        : [
            { key: "spaceSections.rolesCount", vars: { count: counts.roles } },
            ...(counts.customRoles ? [{ key: "spaceSections.rolesCustom", vars: { count: counts.customRoles } }] : []),
          ],
    );
  }
  if (ready.groups && gates.manageGroups) {
    add("groups", [counts.groups === undefined ? { key: "spaceSections.groupsLine" } : { key: "spaceSections.groupsCount", vars: { count: counts.groups } }]);
  }
  if (ready.audit && gates.readAudit) {
    add("audit", [{ key: space.edition === "enterprise" ? "spaceSections.auditLine" : "spaceSections.auditCommunity" }]);
  }
  if (ready.licence && licences && space.role === "owner") {
    add("licence", [
      space.edition === "community"
        ? { key: "spaceSections.licenceCommunity" }
        : space.edition === "frozen"
          ? { key: "spaceSections.licenceFrozen" }
          : space.licence
            ? { key: "spaceSections.licenceSeats", vars: { used: space.licence.used, seats: space.licence.seats } }
            : { key: "spaceSections.licenceEnterprise" },
    ]);
  }
  return out;
}
