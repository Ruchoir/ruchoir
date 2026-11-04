/**
 * A space's Groupes section (mockup frame 7, left): the groups by name, each with its square, the
 * people it holds and the roles it carries, an Annuaire tag on those mirrored from a directory. A
 * group opens its editor (unless it carries a role above the caller's and nothing in it is theirs to
 * change, the web's rule). The floating button creates one: a name and a description, then the editor.
 */
import type { Group, Role, Workspace } from "@ruchoir/client";
import { groupPeople, groupRow, groupTagFor, sortGroups } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronRight, Clock, Lock, Plus, Users } from "lucide-react-native";
import { useCallback } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { groupOpens, rowLine } from "../../logic/groupEditor";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { FloatingButton } from "../../ui/FloatingButton";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { GroupTag, GroupTile, useRoleLabel } from "./GroupParts";

export function SpaceGroupsScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("groups");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Groups space={current} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Groups({ space }: { space: Workspace }) {
  const { listGroups, listRoles, getSpaceMembers } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { gates } = useRights();
  const roleLabel = useRoleLabel();
  const groups = useLoad(`groups:${space.id}`, () => listGroups(space.id));
  const roles = useLoad(`roles:${space.id}`, () => listRoles(space.id));
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const { reload: reloadGroups } = groups;
  const { reload: reloadRoles } = roles;
  const { reload: reloadMembers } = members;
  const reloadAll = useCallback(() => {
    reloadGroups();
    reloadRoles();
    reloadMembers();
  }, [reloadGroups, reloadRoles, reloadMembers]);
  // A group changed here or elsewhere, or the caller's own rights did: read them again.
  useReloadOn((e) => affects.permissions(e, space.id), reloadAll, 300);

  const licensed = space.edition !== "community";
  const frozen = space.edition === "frozen";
  const list = groups.data;
  const roleList: Role[] = roles.data ?? [];
  const shown = list ? sortGroups(list) : [];

  const line = (group: Group) => {
    const row = groupRow(group, roleList, { frozen });
    const { people } = groupPeople(group, members.data ?? []);
    const count = members.data ? people.length : group.memberIds.length;
    return {
      row,
      text: rowLine(count, row.carries.map(roleLabel), licensed)
        .map((part) => String(t(part.key as never, part.vars as never)))
        .join(" · "),
    };
  };

  return (
    <>
      <BackHeader title={t("spaceSections.groups")} subtitle={list ? t("spaceSections.groupsCount", { count: list.length }) : space.name} />
      {!list ? (
        <LoadState error={groups.error} onRetry={reloadAll} />
      ) : list.length === 0 ? (
        <EmptyState icon={Users} title={t("groups.emptyTitle")} text={t("groups.empty")} />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {shown.map((group) => {
            const { row, text } = line(group);
            const opens = groupOpens(group, row.locked);
            return (
              <Pressable
                key={group.id}
                disabled={!opens}
                onPress={() => navigation.navigate("groupEditor", { groupId: group.id })}
                accessibilityRole={opens ? "button" : undefined}
                accessibilityLabel={`${group.name}, ${text}`}
                style={({ pressed }) => [styles.row, pressed && opens && { opacity: 0.6 }]}
              >
                <GroupTile id={group.id} />
                <View style={styles.text}>
                  <View style={styles.nameLine}>
                    <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
                      {group.name}
                    </Text>
                    {group.source === "directory" ? <GroupTag label={t("groups.directoryTag")} /> : null}
                    {groupTagFor(group, members.data) === "guests" ? <GroupTag label={t("guests.sectionTitle")} /> : null}
                  </View>
                  <Text variant="tiny" tone="muted" numberOfLines={2}>
                    {text}
                  </Text>
                </View>
                {row.locked === "above" ? <Lock size={18} color={c.muted} /> : row.locked === "frozen" ? <Clock size={18} color={c.muted} /> : <ChevronRight size={20} color={c.muted} />}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
      {gates.manageGroups && list ? <FloatingButton icon={Plus} label={t("groups.create")} onPress={() => navigation.navigate("groupCreate")} /> : null}
    </>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    fill: { flex: 1 },
    list: { paddingBottom: 96 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    text: { flex: 1, minWidth: 0 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1 },
  }),
);
