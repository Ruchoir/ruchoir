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
  const { getSpaceMembers } = useApi();
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

  const sections = !ready ? [] : sectionsFor(gates, supported, current, { counts: counts ? { people: counts.people, guests: counts.guests } : undefined, licences });
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
