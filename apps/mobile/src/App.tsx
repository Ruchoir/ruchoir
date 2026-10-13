import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useTranslation } from "./i18n";
import { fontFiles, fonts } from "./theme/fonts";
import { useTheme } from "./theme/useTheme";

/** The app's root. Fonts load before anything is drawn, so no text ever flashes in a system face. */
export default function App() {
  const [fontsLoaded] = useFonts(fontFiles);
  const { c, dark } = useTheme();
  const { t } = useTranslation();

  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? "light" : "dark"} />
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Image source={require("../assets/mark.png")} style={styles.mark} accessibilityIgnoresInvertColors />
        {fontsLoaded ? (
          <Text style={[styles.loading, { color: c.muted, fontFamily: fonts.sans }]}>{t("app.loading")}</Text>
        ) : (
          <ActivityIndicator color={c.ink} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  mark: { width: 64, height: 64 },
  loading: { fontSize: 15 },
});
