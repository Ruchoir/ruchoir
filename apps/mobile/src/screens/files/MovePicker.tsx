import { getFolder, updateFile } from "@ruchoir/client";
import { blockedMoveTargets, isTaken } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { ChevronLeft, ChevronRight, Folder } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { entryOf } from "../../files/entry";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/**
 * Where to move an entry (the web's move dialog): the space's folders from its root, browsed in;
 * the folder moved and what is under it cannot be chosen (`blockedMoveTargets`). "Déplacer ici"
 * moves it to the folder shown.
 */
export function MovePicker() {
  const { params } = useRoute<RouteProp<RootParams, "fileMove">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { current } = useSpace();
  const file = params.file;
  const blocked = blockedMoveTargets([entryOf(file)]);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const here = path[path.length - 1];
  const folder = useLoad(`move:${params.spaceId}:${here?.id ?? "root"}`, (signal) => getFolder(params.spaceId, here?.id, signal));
  const folders = (folder.data?.entries ?? []).filter((e) => e.kind === "folder" && e.id);
  const same = (here?.id ?? undefined) === (file.parentFolderId ?? undefined);

  const move = async () => {
    if (same) return navigation.goBack();
    const others = (folder.data?.entries ?? []).map((e) => e.name);
    if (isTaken(file.name, others)) return setError(t("files.nameUsed"));
    setBusy(true);
    try {
      await updateFile(file.id!, { parentFolderId: here?.id ?? null });
      navigation.goBack();
      toast(t("files.moved"));
    } catch {
      setBusy(false);
      setError(t("files.actionFailed"));
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("files.moveOne", { name: file.name })} onClose={() => navigation.goBack()} />
      <View style={[styles.where, { borderBottomColor: c.line }]}>
        {here ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} hitSlop={10} onPress={() => setPath((p) => p.slice(0, -1))}>
            <ChevronLeft size={22} color={c.ink} />
          </Pressable>
        ) : null}
        <Text variant="bodyStrong" numberOfLines={1} style={styles.grow}>
          {here ? path.map((p) => p.name).join(" / ") : (current?.name ?? "")}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {!folder.data ? <LoadState error={folder.error} onRetry={folder.reload} /> : null}
        {folder.data && folders.length === 0 ? <EmptyState size="compact" icon={Folder} title={t("files.folderEmpty")} /> : null}
        {folders.map((f) => {
          const off = blocked.has(f.id!);
          return (
            <Pressable
              key={f.id}
              accessibilityRole="button"
              accessibilityState={{ disabled: off }}
              disabled={off}
              onPress={() => {
                setError(null);
                setPath((p) => [...p, { id: f.id!, name: f.name }]);
              }}
              style={({ pressed }) => [styles.row, { borderBottomColor: c.line }, (pressed || off) && { opacity: off ? 0.4 : 0.6 }]}
            >
              <Folder size={22} color={c.ink} />
              <Text variant="body" numberOfLines={1} style={styles.grow}>
                {f.name}
              </Text>
              {off ? null : <ChevronRight size={18} color={c.muted} />}
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={[styles.foot, { borderTopColor: c.line, paddingBottom: insets.bottom + 8 }]}>
        {error ? (
          <Text variant="small" tone="danger">
            {error}
          </Text>
        ) : null}
        <Button label={t("files.moveHere")} busy={busy} disabled={!folder.data} onPress={() => void move()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  where: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: hairline },
  list: { paddingBottom: 16, flexGrow: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: hairline },
});
