/**
 * The people of a group a message named (mockup frame 8, right): a tap on its pill opens this sheet,
 * with the group's name and how many people it holds, then each person with their picture, their
 * roles and a tag for the group's managers. Whoever may change the group also gets a way into its
 * editor.
 */
import { groupPeople } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pencil, Users } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useMentionGroups } from "../../data/mentionGroups";
import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useRights } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { EmptyState } from "../../ui/States";
import { SheetHeader } from "../../ui/SheetHeader";
import { GroupTag, useRoleLabel } from "../space/GroupParts";

export function GroupPeopleSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { params } = useRoute<RouteProp<RootParams, "groupPeople">>();
  const { current } = useSpace();
  const { listRoles } = useApi();
  const { gates } = useRights();
  const roleLabel = useRoleLabel();
  const space = useSpaceMembers(current?.id);
  // The same cached groups the message that was tapped read them from.
  const groups = useMentionGroups(current?.id);
  // Roles are read by whoever may see them; for anyone else the line under a name is simply absent.
  const roles = useLoad(current ? `roles:${current.id}` : null, () => listRoles(current!.id));

  const group = groups.find((g) => g.id === params.groupId);
  const { people } = groupPeople(group ?? { memberIds: [] }, space.list);
  const rolesOf = (roleIds: string[] | undefined) =>
    (roleIds ?? [])
      .map((id) => roles.data?.find((r) => r.id === id))
      .filter((r) => !!r)
      .map((r) => roleLabel(r))
      .join(", ");
  const canOpen = !!group && gates.manageGroups && Object.entries(group.may).some(([key, allowed]) => !key.startsWith("add") && allowed);

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader
        title={group?.name ?? ""}
        subtitle={group ? t("conversation.people", { count: people.length }) : undefined}
        onClose={() => navigation.goBack()}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}>
        {group && people.length === 0 ? <EmptyState icon={Users} size="compact" title={t("groups.nobody")} /> : null}
        {people.map((m) => (
          <ActionRow
            key={m.userId}
            leading={<Avatar name={m.name} src={m.avatarUrl} kind={m.bot ? "bot" : "person"} size={40} />}
            title={m.name}
            subtitle={rolesOf(m.roleIds) || undefined}
            trailing={group?.managerIds.includes(m.userId) ? <GroupTag label={t("groups.manager")} /> : undefined}
          />
        ))}
        {canOpen ? (
          <ActionRow
            icon={Pencil}
            title={t("groups.openEditor")}
            subtitle={t("groups.openEditorHint")}
            onPress={() => navigation.replace("groupEditor", { groupId: params.groupId })}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 16 },
});
