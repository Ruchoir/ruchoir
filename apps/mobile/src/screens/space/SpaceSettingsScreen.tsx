/**
 * The current space's settings (mockup frame 1): a list of sections, each a screen of its own, with a
 * line under its title. A section the person may not open is not listed (`logic/spaceSections.ts`).
 */
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronRight, FileText, KeyRound, type LucideIcon, Shield, SlidersHorizontal, UserRound, Users } from "lucide-react-native";
import { useEffect } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useFeature } from "../../api/features";
import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { lastChangeStamp } from "../../logic/format";
import { memberCounts } from "../../logic/spaceRoles";
import { sectionsFor, type LinePart, type SectionKey } from "../../logic/spaceSections";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useRights } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { BackHeader } from "../../ui/BackHeader";

const ROUTE: Record<SectionKey, keyof RootParams> = {
  general: "spaceGeneral",
  members: "spaceMembers",
  roles: "spaceRoles",
  groups: "spaceGroups",
  audit: "spaceAudit",
  licence: "spaceLicence",
};

/** Each section's title: General and Members are the app's existing words. */
const TITLE: Record<SectionKey, string> = {
  general: "spaceAdmin.general",
  members: "details.members",
  roles: "spaceSections.roles",
  groups: "spaceSections.groups",
  audit: "spaceSections.audit",
  licence: "spaceSections.licence",
};

const ICON: Record<SectionKey, LucideIcon> = {
  general: SlidersHorizontal,
  members: UserRound,
  roles: Shield,
  groups: Users,
  audit: FileText,
  licence: KeyRound,
};

export function SpaceSettingsScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { getSpaceMembers, listRoles, listGroups, getAudit } = useApi();
  const { locale, timeZone } = useLocale();
  const { current } = useSpace();
  const { ready: rightsReady, supported, gates } = useRights();
  const licencesFeature = useFeature("licences");
  const licences = licencesFeature === true;
  // Until the instance has said what it offers, no list: the legacy two tabs must not flash, nor the screen go back.
  const ready = rightsReady && licencesFeature !== undefined;

  // The members' figures for the line under Membres; the people list itself is its own screen's.
  const members = useLoad(current ? `members:${current.id}` : null, (signal) => getSpaceMembers(current!.id, signal));
  useReloadOn((e) => (current ? affects.members(e, current.id) || affects.permissions(e, current.id) : false), members.reload, 500);
  const counts = members.data ? memberCounts(members.data) : undefined;
  // The roles' figures for the line under Rôles, only for whoever reaches that section.
  const rolesNeeded = ready && supported && gates.managePeople && current !== null;
  const roles = useLoad(rolesNeeded ? `roles:${current.id}` : null, () => listRoles(current!.id));
  useReloadOn((e) => (current ? affects.permissions(e, current.id) : false), roles.reload, 500);
  // The groups' count for the line under Groupes, only for whoever reaches that section.
  const groupsNeeded = ready && supported && gates.manageGroups && current !== null;
  const groups = useLoad(groupsNeeded ? `groups:${current.id}` : null, () => listGroups(current!.id));
  useReloadOn((e) => (current ? affects.permissions(e, current.id) : false), groups.reload, 500);
  const shownRoles = roles.data?.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests");

  // The newest line of the journal for the line under Journal, only where that section says it (a
  // space with a licence; a community space keeps its thirty days).
  const auditNeeded = ready && supported && gates.readAudit && current !== null && current.edition === "enterprise";
  const newest = useLoad(auditNeeded ? `auditLast:${current.id}` : null, () => getAudit(current!.id, { limit: 1 }));
  useReloadOn((e) => (current ? affects.permissions(e, current.id) : false), newest.reload, 500);
  const last = newest.data?.entries[0];
  const lastChange = last
    ? (() => {
        const stamp = lastChangeStamp(last.at, new Date(), locale, timeZone);
        return { day: stamp.day.kind === "today" ? t("files.today") : stamp.day.kind === "yesterday" ? t("files.yesterday") : stamp.day.text, time: stamp.time };
      })()
    : undefined;

  const sections = !ready ? [] : sectionsFor(gates, supported, current, { counts: { ...(counts ? { people: counts.people, guests: counts.guests } : {}), ...(groups.data ? { groups: groups.data.length } : {}), ...(shownRoles ? { roles: shownRoles.length, customRoles: shownRoles.filter((r) => !r.systemKey).length } : {}), ...(lastChange ? { lastChange } : {}) }, licences });
  const tint: Record<SectionKey, string> = { general: c.sky, members: c.mint, roles: c.violet, groups: c.pink, audit: c.sun, licence: c.lime };

  // Nothing left to open (demoted, or their role edited, while here): back to where they came from.
  const empty = ready && current !== null && sections.length === 0;
  useEffect(() => {
    if (empty && navigation.canGoBack()) navigation.goBack();
  }, [empty, navigation]);

  const say = (part: LinePart) => String(t(part.key as never, part.vars as never));

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("spaceAdmin.settings")} subtitle={current?.name} />
      <ScrollView contentContainerStyle={styles.page}>
        {sections.map((section) => (
          <ActionRow
            key={section.key}
            icon={ICON[section.key]}
            tint={tint[section.key]}
            title={t(TITLE[section.key] as never)}
            subtitle={section.line.map(say).join(" · ")}
            onPress={() => navigation.navigate(ROUTE[section.key] as never)}
            trailing={<ChevronRight size={18} color={c.muted} />}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    fill: { flex: 1 },
    page: { paddingHorizontal: 16, paddingBottom: 32 },
  }),
);
