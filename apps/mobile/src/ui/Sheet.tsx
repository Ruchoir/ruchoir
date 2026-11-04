import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PreviewBand } from "../space/PreviewBand";
import { useSpaceIfAny } from "../space/SpaceProvider";
import { useTheme } from "../theme/useTheme";

/** The body of a bottom sheet (a `formSheet` screen of the root stack): surface colour, padded. */
export function Sheet({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const previewing = useSpaceIfAny()?.current?.preview !== undefined;
  return (
    <ScrollView
      style={{ backgroundColor: c.surface }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}
    >
      {previewing ? (
        <View style={styles.band}>
          <PreviewBand />
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  band: { marginHorizontal: -20, marginTop: -24 },
  content: { paddingHorizontal: 20, paddingTop: 24, gap: 6 },
});
