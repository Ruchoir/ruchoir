/**
 * A space's General section: its icon and name (the owner's alone, read by the others), the server's
 * address, its default channel, and the danger zone (leaving it; deleting it, for the owner).
 */
import type { Workspace } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import { Hash, LogOut, Server, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { memberDoors } from "../../logic/sectionGuard";
import { canAdminister, canDeleteSpace, canEditIdentity } from "../../logic/spaceRoles";
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
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { Section } from "../account/Section";
import { useLeaveSpace } from "./useLeaveSpace";

export function SpaceGeneralScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("general");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("spaceAdmin.general")} subtitle={current?.name} />
      {current ? <General space={current} /> : null}
    </SafeAreaView>
  );
}

function General({ space }: { space: Workspace }) {
  const { clearSpaceIcon, getChannels, renameSpace, setSpaceIcon } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { spaces } = useSpace();
  const leave = useLeaveSpace();
  const owner = canEditIdentity(space.role);
  const { supported, gates } = useRights();
  const canDefault = memberDoors(supported, gates, canAdminister(space.role)).defaultChannel;
  const [name, setName] = useState(space.name);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const channels = useLoad(canDefault ? `channels:${space.id}` : null, (signal) => getChannels(space.id, signal));
  // The rights decide whether the arrival channel is read at all: read again when they change.
  useReloadOn((e) => affects.permissions(e, space.id), channels.reload, 300);
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
        {canDefault ? (
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

const makeStyles = styleCache(() =>
  StyleSheet.create({
    fill: { flex: 1 },
    page: { paddingHorizontal: 16, paddingBottom: 32 },
    identity: { flexDirection: "row", alignItems: "center", gap: 16 },
    iconActions: { flex: 1, alignItems: "flex-start", gap: 4 },
    grow: { flex: 1 },
    nameForm: { gap: 10, alignItems: "stretch" },
  }),
);
