/**
 * What the caller may do in the open space, for the settings screens (`@ruchoir/client/permissionsLogic`,
 * the web's gates). `supported` is whether the instance knows the permissions at all: without it the
 * settings keep their two tabs, decided by the legacy role (`logic/spaceSections.ts`).
 */
import { rightsOf, spaceGates } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo } from "react";

import { useSupports } from "../api/features";
import { sectionsFor, type SectionKey } from "../logic/spaceSections";
import { useSpace } from "./SpaceProvider";

export function useRights() {
  const supported = useSupports("permissions");
  const { current } = useSpace();
  return useMemo(() => {
    const rights = rightsOf(current ?? undefined);
    return { supported, rights, gates: spaceGates(current?.role, rights) };
  }, [supported, current]);
}

/**
 * A section's screen goes back when the caller no longer reaches the section (demoted, or their role
 * edited, while it was open). The test is the permission, not whether its screen is built yet.
 */
export function useSectionGuard(key: SectionKey): void {
  const navigation = useNavigation();
  const { current } = useSpace();
  const { supported, gates } = useRights();
  const licences = useSupports("licences");
  const allowed = sectionsFor(gates, supported, current, {
    ready: { roles: true, groups: true, audit: true, licence: true },
    licences,
  }).some((s) => s.key === key);
  // While the space or the instance's features are still loading, stay: only a known answer sends back.
  const known = current !== null;
  useEffect(() => {
    if (known && !allowed && navigation.canGoBack()) navigation.goBack();
  }, [known, allowed, navigation]);
}
