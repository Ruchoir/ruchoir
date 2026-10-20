import type { RuchoirClient, SpaceFile } from "@ruchoir/client";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { ChevronRight, Ellipsis, Folder, Star } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { dayStamp } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { fonts } from "../../theme/fonts";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { FileIcon } from "../../ui/FileIcon";
import { feel } from "../../ui/haptics";
import { Text } from "../../ui/Text";

/** Open what a row stands for: a folder is browsed, a file is shown (with its menu, as a space file). */
export function openEntry(api: RuchoirClient, navigation: Pick<NavigationProp<RootParams>, "navigate">, file: SpaceFile, path?: string): void {
  if (!file.id) return;
  if (file.kind === "folder") navigation.navigate("folder", { folderId: file.id, name: file.name });
  else
    navigation.navigate("fileViewer", {
      file: { id: file.id, name: file.name, url: api.fileDownloadUrl(file.id), mime: file.mimeType, sizeBytes: file.sizeBytes },
      entry: file,
      path,
    });
}

/**
 * A file or a folder in a list (mockup 20): its icon, its name, who touched it last and when. A tap
 * opens it, unless the list does something else with it (`onPress`: the file picker attaches it);
 * otherwise "⋯" and a long press open its menu. `path` is where it sits, for its details.
 */
export function FileRow({ file, line, path, onPress }: { file: SpaceFile; line?: string; path?: string; onPress?: () => void }) {
  const api = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { current } = useSpace();
  const folder = file.kind === "folder";
  const menu = !onPress && file.id && current ? () => navigation.navigate("fileMenu", { file, spaceId: current.id, path }) : undefined;
  const stamp = file.updatedAt ? dayStamp(file.updatedAt, new Date(), locale, timeZone) : null;
  const when = !stamp
    ? null
    : stamp.kind === "today"
      ? t("files.today")
      : stamp.kind === "yesterday"
        ? t("files.yesterday")
        : stamp.text;
  const meta = line ?? [file.modifiedBy ?? file.by, when].filter(Boolean).join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress ?? (() => openEntry(api, navigation, file, path))}
      onLongPress={
        menu
          ? () => {
              feel("menu");
              menu();
            }
          : undefined
      }
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.line }]}
    >
      <FileIcon name={file.name} mime={file.mimeType} folder={folder} />
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
            {file.name}
          </Text>
          {/* A favourite, as on the web: a small filled star beside the name. */}
          {file.starred ? <Star size={13} color={c.bee} fill={c.bee} accessibilityLabel={t("files.favourite")} /> : null}
        </View>
        {meta ? (
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {menu ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("files.more", { name: file.name })} hitSlop={10} onPress={menu} style={styles.more}>
          <Ellipsis size={20} color={c.body} />
        </Pressable>
      ) : folder ? (
        <ChevronRight size={18} color={c.muted} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  more: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { flexShrink: 1 },
});

/** The pastels the folders of a tablet take in turn (tablet mockup 06). */
const FOLDER_TINTS = ["sky", "mint", "violet", "sun", "pink", "peach"] as const;

/**
 * A folder as a card (tablet mockup 06): its tile in a pastel, its name, how many entries it holds.
 * A long press opens its menu.
 */
export function FolderCard({ folder, index }: { folder: SpaceFile; index: number }) {
  const api = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { current } = useSpace();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openEntry(api, navigation, folder)}
      onLongPress={
        current && folder.id
          ? () => {
              feel("menu");
              navigation.navigate("fileMenu", { file: folder, spaceId: current.id });
            }
          : undefined
      }
      style={({ pressed }) => [cards.folder, { borderColor: c.lineStrong, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <View style={[cards.folderTile, { backgroundColor: c[FOLDER_TINTS[index % FOLDER_TINTS.length]] }]}>
        <Folder size={22} color={c.onPastel} />
      </View>
      <View style={cards.text}>
        <Text style={[cards.name, { color: c.ink }]} numberOfLines={1}>
          {folder.name}
        </Text>
        {folder.childCount !== undefined ? (
          <Text style={[cards.meta, { color: c.muted }]}>{t("files.entries", { count: folder.childCount })}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A file as a card (tablet mockup 06): its icon, its name, who touched it and when. */
export function FileCardWide({ file, line, path }: { file: SpaceFile; line?: string; path?: string }) {
  const api = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale, timeZone } = useLocale();
  const navigation = useNavigation<NavigationProp<RootParams>>();
  const { current } = useSpace();
  const stamp = file.updatedAt ? dayStamp(file.updatedAt, new Date(), locale, timeZone) : null;
  const when = !stamp ? null : stamp.kind === "today" ? t("files.today") : stamp.kind === "yesterday" ? t("files.yesterday") : stamp.text;
  const meta = line ?? [file.modifiedBy ?? file.by, when].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openEntry(api, navigation, file, path)}
      onLongPress={
        current && file.id
          ? () => {
              feel("menu");
              navigation.navigate("fileMenu", { file, spaceId: current.id, path });
            }
          : undefined
      }
      style={({ pressed }) => [cards.file, { borderColor: c.lineStrong, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
    >
      <FileIcon name={file.name} mime={file.mimeType} folder={file.kind === "folder"} size={56} />
      <View style={cards.text}>
        <Text style={[cards.name, { color: c.ink }]} numberOfLines={1} ellipsizeMode="middle">
          {file.name}
        </Text>
        {meta ? (
          <Text style={[cards.meta, { color: c.muted }]} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// The tablet mockup's cards: 16 around a folder, 18 around a file, rounded 10.
const cards = StyleSheet.create({
  folder: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: radius.m, borderWidth: hairline },
  folderTile: { width: 44, height: 44, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  file: { gap: 12, padding: 18, borderRadius: radius.m, borderWidth: hairline, minWidth: 0 },
  text: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontSize: 15, lineHeight: 20, fontFamily: fonts.sansSemibold },
  meta: { fontSize: 13, lineHeight: 17 },
});
