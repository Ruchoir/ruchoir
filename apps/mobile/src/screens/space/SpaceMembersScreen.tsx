/**
 * A space's Members section: who is in it, a search, an invitation, and each member the caller
 * outranks opened in a sheet to change their role or remove them.
 */
import type { Workspace } from "@ruchoir/client";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { UserPlus } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { memberDoors } from "../../logic/sectionGuard";
import { canAdminister, grantableRoles, matchesMember, memberCounts } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { SearchField } from "../../ui/SearchField";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { ROLE_LABEL } from "./MemberSheet";

export function SpaceMembersScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("members");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("details.members")} subtitle={current?.name} />
      {current ? <Members space={current} /> : null}
    </SafeAreaView>
  );
}

function Members({ space }: { space: Workspace }) {
  const { getSpaceMembers } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const session = useSession();
  const { supported, gates } = useRights();
  const doors = memberDoors(supported, gates, canAdminister(space.role));
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const { reload } = members;
  // Someone joining, leaving or changing role, here or elsewhere; and back from a member's sheet.
  useReloadOn((e) => affects.members(e, space.id) || affects.permissions(e, space.id), reload, 300);
  useFocusEffect(useCallback(() => reload(), [reload]));
  const [query, setQuery] = useState("");
  const me = session.state.kind === "signedIn" ? session.state.user.id : undefined;
  const list = members.data;
  const shown = list?.filter((m) => matchesMember(m, query)) ?? [];
  const counts = list ? memberCounts(list) : null;
  const summary = counts
    ? [
        t("details.membersCount", { count: counts.people }),
        counts.guests > 0 ? t("spaceAdmin.guests", { count: counts.guests }) : null,
        counts.bots > 0 ? t("spaceAdmin.bots", { count: counts.bots }) : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  if (!list) return <LoadState error={members.error} onRetry={reload} />;
  return (
    <FlatList
      data={shown}
      keyExtractor={(m) => m.userId}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.head}>
          <Text tone="muted">{summary}</Text>
          <SearchField value={query} onChange={setQuery} placeholder={t("spaceAdmin.search")} />
          {doors.invite ? <ActionRow icon={UserPlus} tint={c.pink} title={t("spaceAdmin.invite")} onPress={() => navigation.navigate("invite")} /> : null}
        </View>
      }
      ListEmptyComponent={
        <Text tone="muted" style={styles.empty}>
          {t("spaceAdmin.noMatch")}
        </Text>
      }
      renderItem={({ item: m }) => {
        const mine = m.userId === me;
        // A bot has no role; my own row and anyone not ranked below me are read only.
        const reachable = doors.changeRole && !m.bot && !mine && grantableRoles(space.role, m.role).length > 0;
        const tag = m.bot ? t("spaceAdmin.bot") : t(ROLE_LABEL[m.role] ?? ROLE_LABEL.member);
        return (
          <ActionRow
            leading={<Avatar name={m.name} src={m.avatarUrl} kind={m.bot ? "bot" : "person"} size={40} />}
            title={mine ? `${m.name} (${t("spaceAdmin.you")})` : m.name}
            subtitle={m.title}
            onPress={reachable ? () => navigation.navigate("spaceMember", { userId: m.userId }) : undefined}
            trailing={
              <Text variant="tiny" tone="muted" style={[styles.role, { backgroundColor: s.sunken }]}>
                {tag}
              </Text>
            }
          />
        );
      }}
    />
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    list: { paddingHorizontal: 16, paddingBottom: 32 },
    head: { gap: 10, paddingTop: 8, paddingBottom: 4 },
    empty: { paddingVertical: 16, textAlign: "center" },
    role: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: shape.radius.s, overflow: "hidden" },
  }),
);
