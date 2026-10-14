import { deleteFile, fileDownloadUrl, setStarred } from "@ruchoir/client";
import { actionsFor, canManage, type ActionId } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Sharing from "expo-sharing";
import { FolderOpen, Info, PencilLine, Share as ShareIcon, Star, StarOff, Trash2, type LucideIcon } from "lucide-react-native";
import { Alert, StyleSheet, View } from "react-native";

import { entryOf } from "../../files/entry";
import { downloadToCache } from "../../files/download";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { fileSize } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { FileIcon } from "../../ui/FileIcon";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { openEntry } from "./FileRow";

/**
 * What can be done with a file or a folder (the web's menu, `actionsFor`): each action only for who
 * may, in the web's order. Opened from a row's "⋯" or a long press, and from the viewer.
 */
export function EntryMenu() {
  const { params } = useRoute<RouteProp<RootParams, "fileMenu">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const toast = useToast();
  const { current } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const file = params.file;
  const entry = entryOf(file);
  const manage = canManage(file, me, current?.role);
  const close = () => navigation.goBack();

  const run: Partial<Record<ActionId, () => void>> = {
    open: () => {
      close();
      openEntry(navigation, file, params.path);
    },
    download: () => {
      close();
      void downloadToCache({ id: file.id!, name: file.name, url: fileDownloadUrl(file.id!), mime: file.mimeType, sizeBytes: file.sizeBytes })
        .then((uri) => Sharing.shareAsync(uri, { mimeType: file.mimeType, dialogTitle: file.name }))
        .catch(() => toast(t("files.actionFailed")));
    },
    star: () => {
      close();
      const next = !file.starred;
      setStarred(file.id!, next).then(
        () => toast(next ? t("files.favoured") : t("files.unfavoured")),
        () => toast(t("files.actionFailed")),
      );
    },
    rename: () =>
      navigation.replace("fileName", { mode: "rename", spaceId: params.spaceId, folderId: file.parentFolderId, fileId: file.id, name: file.name }),
    details: () => navigation.replace("fileDetails", { file, spaceId: params.spaceId, path: params.path }),
    delete: () =>
      Alert.alert(t("files.deleteConfirm", { name: file.name }), undefined, [
        { text: t("compose.cancel"), style: "cancel" },
        {
          text: t("compose.delete"),
          style: "destructive",
          onPress: () => {
            close();
            deleteFile(file.id!).then(
              () => toast(t("files.trashedOne")),
              () => toast(t("files.deleteFailed")),
            );
          },
        },
      ]),
  };
  const look: Partial<Record<ActionId, { icon: LucideIcon; tint?: string; title: string }>> = {
    open: { icon: FolderOpen, tint: c.sky, title: t("today.open") },
    download: { icon: ShareIcon, tint: c.violet, title: t("viewer.share") },
    star: file.starred ? { icon: StarOff, tint: c.sun, title: t("sidebar.unfavourite") } : { icon: Star, tint: c.sun, title: t("sidebar.favourite") },
    rename: { icon: PencilLine, tint: c.mint, title: t("files.rename") },
    details: { icon: Info, title: t("details.title") },
  };
  const actions = actionsFor(entry, manage).filter((a) => a !== "delete" && run[a] && look[a]);
  const folder = file.kind === "folder";
  return (
    <Sheet>
      <View style={styles.head}>
        <FileIcon name={file.name} mime={file.mimeType} folder={folder} />
        <View style={styles.grow}>
          <Text variant="heading" numberOfLines={2}>
            {file.name}
          </Text>
          <Text variant="small" tone="muted">
            {folder ? t("files.typeFolder") : fileSize(file.sizeBytes, locale)}
          </Text>
        </View>
      </View>
      {actions.map((a) => (
        <ActionRow key={a} icon={look[a]!.icon} tint={look[a]!.tint} title={look[a]!.title} onPress={run[a]} />
      ))}
      {actionsFor(entry, manage).includes("delete") ? (
        <View style={[styles.danger, { borderTopColor: c.line }]}>
          <ActionRow icon={Trash2} danger title={t("compose.delete")} onPress={run.delete} />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  grow: { flex: 1, minWidth: 0 },
  danger: { marginTop: 6, paddingTop: 6, borderTopWidth: hairline },
});
