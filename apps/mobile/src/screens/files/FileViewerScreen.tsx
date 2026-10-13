import { fileFamily } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import * as Sharing from "expo-sharing";
import { Image } from "expo-image";
import { Share, X } from "lucide-react-native";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { useLoad } from "../../data/useLoad";
import { downloadToCache } from "../../files/download";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FileIcon } from "../../ui/FileIcon";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";

/**
 * A file, opened in the app: an image as itself, a PDF or an office document through the system's
 * own renderer (iOS draws them in a web view), and "Share / Open in" for everything, including what
 * the phone cannot show here.
 */
export function FileViewerScreen() {
  const { params } = useRoute<RouteProp<RootParams, "fileViewer">>();
  const { file } = params;
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const local = useLoad(`download:${file.id}:${file.url}`, (signal) => downloadToCache(file, signal));
  const family = fileFamily(file.name, file.mime);
  const inline = family === "image" || (Platform.OS === "ios" && ["pdf", "document", "spreadsheet", "presentation", "text"].includes(family));

  const share = () => {
    if (local.data) void Sharing.shareAsync(local.data, { mimeType: file.mime, dialogTitle: file.name });
  };

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]}>
      <View style={[styles.bar, { borderBottomColor: c.line }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => navigation.goBack()} style={styles.icon}>
          <X size={24} color={c.ink} />
        </Pressable>
        <Text variant="heading" numberOfLines={1} style={styles.title}>
          {file.name}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("viewer.share")} disabled={!local.data} onPress={share} style={styles.icon}>
          <Share size={22} color={local.data ? c.ink : c.muted} />
        </Pressable>
      </View>
      {!local.data ? (
        <LoadState error={local.error} onRetry={local.reload} />
      ) : family === "image" ? (
        <Image source={{ uri: local.data }} style={styles.fill} contentFit="contain" accessibilityLabel={file.name} />
      ) : inline ? (
        <WebView
          source={{ uri: local.data }}
          originWhitelist={["*"]}
          allowingReadAccessToURL={local.data.replace(/[^/]+$/, "")}
          allowFileAccess
          style={styles.fill}
        />
      ) : (
        <View style={styles.center}>
          <FileIcon name={file.name} mime={file.mime} size={72} />
          <Text variant="heading" style={styles.text}>
            {t("viewer.noPreview")}
          </Text>
          <Button label={t("viewer.share")} onPress={share} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, minHeight: 52, borderBottomWidth: hairline },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  text: { textAlign: "center" },
});
