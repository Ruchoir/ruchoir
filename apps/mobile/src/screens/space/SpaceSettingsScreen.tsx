/**
 * The current space's settings, the web's `WorkspaceSettings` on a phone, for its owner and admins:
 *
 * - General: its icon and name (the owner's alone, read by the others), the server's address, its
 *   default channel, and the danger zone (leaving it; deleting it, for the owner).
 * - Members: who is in it, a search, an invitation, and each member the caller outranks opened in a
 *   sheet to change their role or remove them.
 */
import type { Workspace } from "@ruchoir/client";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import { Hash, LogOut, Server, Trash2, UserPlus } from "lucide-react-native";
import { useCallback, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { canAdminister, canDeleteSpace, canEditIdentity, grantableRoles, matchesMember, memberCounts } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SearchField } from "../../ui/SearchField";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { Section } from "../account/Section";
import { ROLE_LABEL } from "./MemberSheet";
import { useLeaveSpace } from "./useLeaveSpace";

type Tab = "general" | "members";

export function SpaceSettingsScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();
  const [tab, setTab] = useState<Tab>("general");
  // The members are administration: a caller demoted while here keeps the general tab only.
  const admin = canAdminister(current?.role);
  const shown: Tab = admin ? tab : "general";

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("spaceAdmin.settings")} subtitle={current?.name} />
      {admin ? (
        <Segmented
          options={[
            { key: "general", label: t("spaceAdmin.general") },
            { key: "members", label: t("details.members") },
          ]}
          value={shown}
          onChange={setTab}
          style={styles.tabs}
        />
      ) : null}
      {!current ? null : shown === "general" ? <General space={current} /> : <Members space={current} />}
    </SafeAreaView>
  );
}

function General({ space }: { space: Workspace }) {
  const { clearSpaceIcon, getChannels, renameSpace, setSpaceIcon } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { spaces } = useSpace();
  const leave = useLeaveSpace();
  const owner = canEditIdentity(space.role);
  const [name, setName] = useState(space.name);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const channels = useLoad(canAdminister(space.role) ? `channels:${space.id}` : null, (signal) => getChannels(space.id, signal));
  const defaultChannel = channels.data?.find((ch) => ch.id === space.defaultChannelId);
  const server = session.state.kind === "signedIn" ? session.state.server : undefined;
  const renamed = name.trim() !== "" && name.trim() !== space.name;

  const rename = async () => {
    setSaving(true);
    try {
      await renameSpace(space.id, name.trim());
      spaces.reload();
      toast(t("spaceAdmin.renamed"), "success");
    } catch {
      toast(t("spaceAdmin.nameFailed"), "failure");
    } finally {
      setSaving(false);
    }
  };

  const pickIcon = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    setIconBusy(true);
    try {
      await setSpaceIcon(space.id, { uri: asset.uri, name: "icon.jpg", type: asset.mimeType ?? "image/jpeg" });
      spaces.reload();
    } catch {
      toast(t("spaceAdmin.iconFailed"), "failure");
    } finally {
      setIconBusy(false);
    }
  };

  const removeIcon = async () => {
    setIconBusy(true);
    try {
      await clearSpaceIcon(space.id);
      spaces.reload();
    } catch {
      toast(t("spaceAdmin.iconFailed"), "failure");
    } finally {
      setIconBusy(false);
    }
  };

  return (
    <KeyboardForm contentContainerStyle={styles.page}>
      <Section label={t("spaceAdmin.icon")}>
        <View style={styles.identity}>
          <Avatar name={space.name} src={space.iconUrl} kind="workspace" size={72} />
          {owner ? (
            <View style={styles.iconActions}>
              <Button variant="secondary" size="sm" label={t("spaceAdmin.changeIcon")} onPress={() => void pickIcon()} busy={iconBusy} />
              {space.iconUrl ? <Button variant="ghost" size="sm" label={t("spaceAdmin.removeIcon")} onPress={() => void removeIcon()} /> : null}
            </View>
          ) : (
            <Text tone="muted" style={styles.grow}>
              {t("spaceAdmin.ownerOnly")}
            </Text>
          )}
        </View>
      </Section>

      <Section label={t("joinSpace.name")}>
        {owner ? (
          <View style={styles.nameForm}>
            <TextField label={t("joinSpace.name")} value={name} onChangeText={setName} hint={t("spaceAdmin.addressFollowsName")} />
            <Button variant="secondary" size="md" label={t("spaceAdmin.saveName")} onPress={() => void rename()} busy={saving} disabled={!renamed} />
          </View>
        ) : (
          <Text variant="bodyStrong">{space.name}</Text>
        )}
      </Section>

      <Section label={t("spaceAdmin.serverAddress")}>
        <ActionRow icon={Server} title={server ?? ""} />
        {canAdminister(space.role) ? (
          <ActionRow
            icon={Hash}
            tint={c.sky}
            title={defaultChannel ? defaultChannel.name : t("spaceAdmin.defaultChannelNone")}
            subtitle={t("spaceAdmin.defaultChannel")}
            onPress={() => navigation.navigate("spaceDefaultChannel")}
          />
        ) : null}
      </Section>

      <Section label={t("spaceAdmin.danger")}>
        <ActionRow icon={LogOut} title={t("spaceAdmin.leave")} subtitle={t("spaceAdmin.leaveHint")} danger onPress={() => leave(space)} />
        {canDeleteSpace(space.role) ? (
          <ActionRow
            icon={Trash2}
            title={t("spaceAdmin.delete")}
            subtitle={t("spaceAdmin.deleteHint")}
            danger
            onPress={() => navigation.navigate("spaceDelete")}
          />
        ) : null}
      </Section>
    </KeyboardForm>
  );
}

function Members({ space }: { space: Workspace }) {
  const { getSpaceMembers } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const { reload } = members;
  // Someone joining, leaving or changing role, here or elsewhere; and back from a member's sheet.
  useReloadOn((e) => affects.members(e, space.id), reload, 300);
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
          <ActionRow icon={UserPlus} tint={c.pink} title={t("spaceAdmin.invite")} onPress={() => navigation.navigate("invite")} />
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
        const reachable = !m.bot && !mine && grantableRoles(space.role, m.role).length > 0;
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { marginTop: 4, marginBottom: 8 },
  page: { paddingHorizontal: 16, paddingBottom: 32 },
  identity: { flexDirection: "row", alignItems: "center", gap: 16 },
  iconActions: { flex: 1, alignItems: "flex-start", gap: 4 },
  grow: { flex: 1 },
  nameForm: { gap: 10, alignItems: "stretch" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  head: { gap: 10, paddingTop: 8, paddingBottom: 4 },
  empty: { paddingVertical: 16, textAlign: "center" },
  role: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.s, overflow: "hidden" },
});
