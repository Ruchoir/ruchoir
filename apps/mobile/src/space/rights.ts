/**
 * What the caller may do in the open space, for the settings screens (`@ruchoir/client/permissionsLogic`,
 * the web's gates). `supported` is whether the instance knows the permissions at all: without it the
 * settings keep their two tabs, decided by the legacy role (`logic/spaceSections.ts`).
 */
import { rightsOf, spaceGates } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo } from "react";

import { useFeature } from "../api/features";
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
