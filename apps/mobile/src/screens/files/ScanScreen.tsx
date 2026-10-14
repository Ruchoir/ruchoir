/**
 * "Scan a document": photos of its pages, taken one after the other, made into one PDF on the phone
 * (`logic/scan.ts`, `expo-print`) and sent like any file, into the folder the person is in. Expo Go
 * has no document scanner (edges, perspective): that waits for the native app.
 */
import { getFolder } from "@ruchoir/client";
import { canManage } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as Print from "expo-print";
import { Plus, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { cameraAllowed } from "../../compose/pick";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { leaveScan, scanHtml, scanName, scanPageSize } from "../../logic/scan";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FullScreen } from "../../ui/FullScreen";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { useUploads } from "../../uploads/UploadsProvider";

type Page = { uri: string; width: number; height: number };

/** One A4 sheet in PostScript points, as `expo-print` takes it. */
const A4 = { width: 595, height: 842 };

export function ScanScreen() {
  const { params } = useRoute<RouteProp<RootParams, "scan">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { timeZone } = useLocale();
  const toast = useToast();
  const { current } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const uploads = useUploads();
  const [pages, setPages] = useState<Page[]>([]);
  const proposedName = () =>
    scanName(new Date(), timeZone, (v) => t("files.scanName", { day: v.day, month: v.month, year: v.year, hour: v.hour, minute: v.minute }));
  const [name, setName] = useState(proposedName);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const started = useRef(false);

  const takePage = async () => {
    if (!(await cameraAllowed(t))) return false;
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (result.canceled) return false;
    const a = result.assets[0];
    setPages((prev) => [...prev, { uri: a.uri, width: a.width, height: a.height }]);
    return true;
  };

  // The camera opens at once for the first page; cancelled, there is nothing to scan.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void takePage().then((taken) => {
      if (!taken) {
        done.current = true;
        navigation.goBack();
      }
    });
    // Once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving with pages taken asks first.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        const choice = leaveScan({ done: done.current, busy, pages: pages.length });
        if (choice === "leave") return;
        e.preventDefault();
        if (choice === "stay") return;
        Alert.alert(t("files.scanDiscardTitle"), t("files.scanDiscardText"), [
          { text: t("eventForm.keepEditing"), style: "cancel" },
          { text: t("eventForm.discard"), style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation, pages.length, busy, t],
  );

  const save = async () => {
    if (pages.length === 0 || busy) return;
    setBusy(true);
    try {
      const shrunk = [];
      for (const page of pages) {
        const size = scanPageSize(page.width, page.height);
        const image = await ImageManipulator.manipulate(page.uri).resize(size).renderAsync();
        const saved = await image.saveAsync({ base64: true, compress: 0.7, format: SaveFormat.JPEG });
        shrunk.push({ base64: saved.base64 ?? "", width: saved.width, height: saved.height });
      }
      const pdf = await Print.printToFileAsync({ html: scanHtml(shrunk), ...A4 });
      const fileName = `${name.trim() || proposedName()}.pdf`;
      const entries = await getFolder(params.spaceId, params.folderId).then(
        (f) => f.entries,
        () => [],
      );
      const existing = entries.flatMap((e) => (e.id ? [{ id: e.id, name: e.name, manage: canManage(e, me, current?.role) }] : []));
      const asks = uploads.add(
        [{ uri: pdf.uri, name: fileName, mime: "application/pdf", size: new File(pdf.uri).size }],
        { spaceId: params.spaceId, folderId: params.folderId },
        existing,
        params.folderName,
      );
      done.current = true;
      if (asks) {
        feel("warning");
        navigation.replace("uploadConflict");
      }
      else navigation.goBack();
    } catch {
      setBusy(false);
      toast(t("files.scanFailed"), "failure");
    }
  };

  return (
    <FullScreen color={c.surface} bottom={false}>
      <SheetHeader title={t("files.scanTitle")} onClose={() => navigation.goBack()} />
      <KeyboardForm
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.form}
        footer={
          <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
            <Button label={t("compose.save")} busy={busy} disabled={pages.length === 0} onPress={() => void save()} />
          </View>
        }
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pages}>
          {pages.map((page, i) => (
            <View key={page.uri} style={[styles.page, { borderColor: c.line, backgroundColor: s.sunken }]}>
              <Image source={{ uri: page.uri }} style={styles.thumb} contentFit="contain" accessibilityLabel={t("files.page", { n: i + 1 })} />
              <Text variant="tiny" tone="muted" style={styles.pageNo}>
                {t("files.page", { n: i + 1 })}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("attach.remove", { name: t("files.page", { n: i + 1 }) })}
                hitSlop={8}
                onPress={() => setPages((prev) => prev.filter((p) => p.uri !== page.uri))}
                style={({ pressed }) => [styles.cross, { backgroundColor: c.surface, borderColor: c.line }, pressed && { opacity: 0.6 }]}
              >
                <X size={14} color={c.ink} />
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => void takePage()}
            style={({ pressed }) => [styles.page, styles.add, { borderColor: c.controlLine }, pressed && { opacity: 0.6 }]}
          >
            <Plus size={22} color={c.ink} />
            <Text variant="smallStrong" style={styles.addText}>
              {t("files.addPage")}
            </Text>
          </Pressable>
        </ScrollView>
        <View style={styles.gutter}>
          <TextField label={t("files.scanNameLabel")} value={name} onChangeText={setName} autoCapitalize="sentences" returnKeyType="done" maxLength={200} />
        </View>
      </KeyboardForm>
    </FullScreen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 20, paddingTop: 8, paddingBottom: 24 },
  gutter: { paddingHorizontal: 16 },
  pages: { gap: 12, paddingHorizontal: 16 },
  page: { width: 132, height: 186, borderRadius: radius.m, borderWidth: hairline, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  thumb: { width: "100%", height: "100%" },
  pageNo: { position: "absolute", bottom: 6, left: 8 },
  cross: { position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  add: { borderStyle: "dashed", gap: 6 },
  addText: { textAlign: "center", paddingHorizontal: 8 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
