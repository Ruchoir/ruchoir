/**
 * What the caller may do in the open space, for the settings screens (`@ruchoir/client/permissionsLogic`,
 * the web's gates). `supported` is whether the instance knows the permissions at all: without it the
 * settings keep their two tabs, decided by the legacy role (`logic/spaceSections.ts`).
 */
import type { Channel } from "@ruchoir/client";
import { channelGates, createGates, rightsOf, spaceGates } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo } from "react";

import { useFeature } from "../api/features";
import { legacyDoors, PHONE_LEGACY_CHANNEL } from "../logic/spaceRoles";
import { guardDecision } from "../logic/sectionGuard";
import { sectionsFor, type SectionKey } from "../logic/spaceSections";
import { useSpace } from "./SpaceProvider";

export function useRights() {
  const permissions = useFeature("permissions");
  const { current } = useSpace();
  return useMemo(() => {
    const rights = rightsOf(current ?? undefined);
    // `ready`: the instance has said what it offers; before that `supported` reads false and must not be acted on.
    return { ready: permissions !== undefined, supported: permissions === true, rights, gates: spaceGates(current?.role, rights) };
  }, [permissions, current]);
}

/**
 * What the caller may do in one channel (`channelGates`), from the rights the server listed for it, or
 * the role on an older instance. Undefined (a private conversation, or a channel not loaded yet) reads
 * as the older rule, which lets a person write: the server stays the judge.
 */
export function useChannelGates(channel: Pick<Channel, "myPermissions"> | null | undefined, legacyChannelRole?: string) {
  const { supported } = useRights();
  const { current } = useSpace();
  return useMemo(
    () => channelGates(channel ?? undefined, current ?? undefined, supported, { ...PHONE_LEGACY_CHANNEL, legacyChannelRole }),
    [channel, current, supported, legacyChannelRole],
  );
}

/**
 * The creating buttons of the open space (a message to someone, a new group, an invitation), each on
 * its own right: `dm.start`, `channels.create`, `members.invite`. An older instance keeps its rule
 * (inviting is for the owner and the administrators).
 */
export function useCreateGates() {
  const { supported, gates } = useRights();
  const { current } = useSpace();
  return useMemo(
    () => ({ ...createGates(current ?? undefined, supported), invite: supported ? gates.invite : legacyDoors(current?.role).invite }),
    [current, supported, gates],
  );
}

/**
 * A section's screen goes back when the caller no longer reaches the section (demoted, or their role
 * edited, while it was open). The test is the permission, not whether its screen is built yet.
 */
export function useSectionGuard(key: SectionKey): void {
  const navigation = useNavigation();
  const { current } = useSpace();
  const { ready, supported, gates } = useRights();
  const licences = useFeature("licences");
  const allowed = sectionsFor(gates, supported, current, {
    ready: { roles: true, groups: true, audit: true, licence: true },
    licences: licences === true,
  }).some((s) => s.key === key);
  const decision = guardDecision({ known: current !== null, ready: ready && licences !== undefined, allowed });
  useEffect(() => {
    if (decision === "leave" && navigation.canGoBack()) navigation.goBack();
  }, [decision, navigation]);
}
