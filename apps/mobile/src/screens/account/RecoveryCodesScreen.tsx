import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { Copy, Share2 } from "lucide-react-native";
import { ScrollView, Share, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { fonts } from "../../theme/fonts";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** New recovery codes, shown this once: to copy or share somewhere else than this phone. */
export function RecoveryCodesScreen() {
  const { codes } = useRoute<RouteProp<RootParams, "recoveryCodes">>().params;
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation();
  const all = codes.join("\n");
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <SheetHeader title={t("security.recoveryCodes")} onClose={() => navigation.goBack()} />
      <View style={styles.pad}>
        <Text tone="body">{t("security.recoveryKeep")}</Text>
        <View style={[styles.codes, { backgroundColor: c.surface, borderColor: c.line }]}>
          {codes.map((code) => (
            <Text key={code} selectable style={[styles.code, { color: c.ink }]}>
              {code}
            </Text>
          ))}
        </View>
        <View style={styles.row}>
          <Button
            variant="secondary"
            label={t("security.copyCodes")}
            icon={<Copy size={18} color={c.ink} />}
            onPress={() => void Clipboard.setStringAsync(all).then(() => toast(t("security.codesCopied")))}
            style={styles.flex}
          />
          <Button
            variant="secondary"
            label={t("files.share")}
            icon={<Share2 size={18} color={c.ink} />}
            onPress={() => void Share.share({ message: all }).catch(() => {})}
            style={styles.flex}
          />
        </View>
        <Button label={t("security.notedThem")} onPress={() => navigation.goBack()} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  pad: { paddingHorizontal: 20, gap: 16 },
  codes: { flexDirection: "row", flexWrap: "wrap", padding: 16, borderRadius: radius.m, borderWidth: 1.5, rowGap: 10 },
  code: { width: "50%", fontFamily: fonts.monoSemibold, fontSize: 15, letterSpacing: 0.5 },
  row: { flexDirection: "row", gap: 10 },
  flex: { flex: 1 },
});
