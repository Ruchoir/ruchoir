/**
 * A member of the current space, pushed from the members list (mockups 3): their header, and two
 * tabs, Profil (who they are) and Gestion (their roles, standing and removal, for whoever may manage
 * them). On an instance older than the permissions it keeps the single-role sheet it always was.
 */
import type { Group, Member, Role, Workspace } from "@ruchoir/client";
import { groupRow, groupTagFor, importedGroupSource } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { heldRoles, memberStatus, roleColourKey, shortDay, systemRoleKey } from "../../logic/memberScreen";
import { grantableRoles } from "../../logic/spaceRoles";
import { groupOpens } from "../../logic/groupEditor";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { RoleChip } from "../../ui/RoleChip";
import { GroupChip } from "./GroupParts";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { Section } from "../account/Section";
import { LegacyRoles } from "./MemberLegacy";
import { MemberManage } from "./MemberManage";
import { LEGACY_LABEL, SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";

type Tab = "profile" | "manage";

export function MemberScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("members");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Person space={current} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Person({ space }: { space: Workspace }) {
  const { getSpaceMembers, listRoles, listGroups } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "spaceMember">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const session = useSession();
  const toast = useToast();
  const { supported } = useRights();
  const [tab, setTab] = useState<Tab>(params.prolong ? "manage" : "profile");
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const roles = useLoad(supported ? `roles:${space.id}` : null, () => listRoles(space.id));
  const groups = useLoad(supported ? `groups:${space.id}` : null, () => listGroups(space.id).catch(() => [] as Group[]));
  const reloadAll = useCallback(() => {
    members.reload();
    roles.reload();
    groups.reload();
  }, [members, roles, groups]);
  // The person's roles, the roles themselves, the groups: read again as they change, and a person
  // who is no longer here sends the screen back.
  useReloadOn((e) => affects.members(e, space.id) || affects.permissions(e, space.id), reloadAll, 300);
  const me = session.state.kind === "signedIn" ? session.state.user.id : undefined;
  const list = members.data;
  const member = list?.find((m) => m.userId === params.userId);
  // A notice or a link selects its space and navigates at once: until the current space is that one, the list says nothing about the person.
  const status = memberStatus({ spaceId: params.spaceId, currentId: space.id, listed: !!list, found: !!member });
  const told = useRef(false);
  useEffect(() => {
    if (status !== "gone" || told.current) return;
    told.current = true;
    toast(t("members.gone"));
    if (navigation.canGoBack()) navigation.goBack();
  }, [status, navigation, toast, t]);

  if (!member || status !== "ready") {
    return (
      <>
        <BackHeader title="" />
        <LoadState error={members.error} onRetry={members.reload} />
      </>
    );
  }

  const mine = member.userId === me;
  // An older server says nothing of `manageable`: the legacy ranks decide.
  const manageable = supported ? member.manageable === true && !mine && !member.bot : !member.bot && !mine && grantableRoles(space.role, member.role).length > 0;
  const standing = member.standing ?? member.role;
  const line = [member.title, t(LEGACY_LABEL[standing as keyof typeof LEGACY_LABEL] ?? LEGACY_LABEL.member)].filter(Boolean).join(" · ");
  const header = <BackHeader title={member.name} subtitle={member.bot ? member.title : line} leading={<Avatar name={member.name} src={member.avatarUrl} kind={member.bot ? "bot" : "person"} size={36} />} />;

  if (!supported) {
    return (
      <>
        {header}
        <ScrollView contentContainerStyle={styles.legacy}>
          <LegacyRoles space={space} member={member} />
        </ScrollView>
      </>
    );
  }

  // A person demoted to where they cannot manage this one lands back on the profile.
  const shown: Tab = manageable ? tab : "profile";
  const ready = roles.data !== undefined;
  return (
    <>
      {header}
      {manageable ? (
        <Segmented
          style={styles.tabs}
          value={shown}
          onChange={setTab}
          options={[
            { key: "profile", label: t("profile.tabProfile") },
            { key: "manage", label: t("profile.tabManage") },
          ]}
        />
      ) : null}
      {shown === "profile" ? (
        <Profile space={space} member={member} roles={roles.data ?? []} groups={groups.data ?? []} people={list} />
      ) : ready ? (
        <MemberManage space={space} member={member} me={list?.find((m) => m.userId === me)} roles={roles.data ?? []} groups={groups.data ?? []} people={list} onChanged={reloadAll} />
      ) : (
        <LoadState error={roles.error} onRetry={roles.reload} />
      )}
    </>
  );
}

/** Who they are: their roles, since when, until when for a guest, their groups, where an import brought them from. */
function Profile({ space, member, roles, groups, people }: { space: Workspace; member: Member; roles: Role[]; groups: Group[]; people?: Member[] }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { locale, timeZone: zone } = useLocale();
  const now = new Date();
  const held = heldRoles(member, roles, groups);
  const mine = groups.filter((g) => g.memberIds.includes(member.userId));
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { supported, gates } = useRights();
  const frozen = space.edition === "frozen";
  // A group opens for whoever reaches the Groupes section and may open that group (the list's own rule).
  const opens = (g: Group) => supported && gates.manageGroups && groupOpens(g, groupRow(g, roles, { frozen }).locked);
  const source = importedGroupSource({ importedFrom: member.importedFrom });
  const guest = member.role === "guest";
  const since = member.joinedAt ? shortDay(member.joinedAt, locale, zone, now) : "";
  return (
    <ScrollView contentContainerStyle={styles.profile}>
      {member.bot ? null : (
        <Section label={t("spaceSections.roles")}>
          <View style={styles.wrap}>
            {member.role === "owner" ? <RoleChip label={t(LEGACY_LABEL.owner)} colour="violet" /> : null}
            {guest ? <RoleChip label={t(LEGACY_LABEL.guest)} colour="sky" /> : null}
            {held.map(({ role, via: from }) => {
              const named = systemRoleKey(role);
              return <RoleChip key={role.id} label={named ? t(SYSTEM_ROLE_LABEL[named]) : role.name} colour={roleColourKey(role)} viaGroup={from.length > 0} />;
            })}
            {member.role === "member" && held.length === 0 ? (
              <Text variant="small" tone="muted">
                {t("roles.membersOnly")}
              </Text>
            ) : null}
          </View>
        </Section>
      )}
      {since ? (
        <Text variant="small" tone="muted" style={styles.line}>
          {guest ? t("roles.guestSince", { date: since }) : t("roles.memberSince", { date: since })}
        </Text>
      ) : null}
      {guest ? (
        <Text variant="small" tone="muted" style={styles.line}>
          {member.expiresAt ? t("guests.guestUntil", { date: shortDay(member.expiresAt, locale, zone, now) }) : t("guests.noEnd")}
        </Text>
      ) : null}
      {mine.length > 0 ? (
        <Section label={t("spaceSections.groups")}>
          <View style={styles.wrap}>
            {mine.map((g) => (
              <GroupChip key={g.id} name={g.name} guestsOnly={groupTagFor(g, people) === "guests"} onPress={opens(g) ? () => navigation.navigate("groupEditor", { groupId: g.id }) : undefined} />
            ))}
          </View>
        </Section>
      ) : null}
      {source ? (
        <Text variant="small" tone="muted" style={styles.line}>
          {t("groups.importedFrom", { source })}
        </Text>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    fill: { flex: 1 },
    tabs: { marginBottom: 4 },
    legacy: { paddingBottom: 24 },
    profile: { paddingHorizontal: 16, paddingBottom: 24 },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    line: { paddingTop: 12 },
  }),
);
