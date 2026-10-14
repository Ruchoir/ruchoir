import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronLeft } from "lucide-react-native";
import { useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";

import { useTranslation } from "../../i18n";
import type { AuthParams, RootParams } from "../../navigation/types";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { FullScreen } from "../../ui/FullScreen";
import { Text } from "../../ui/Text";
import { Sticker } from "./Sticker";
import { TUTORIAL } from "./tutorial";

/**
 * The tutorial (mockups 02 and 03): four pages, swiped or turned with "Next", skipped at any time.
 * Before an account it ends on sign-up; seen again from Help (`replay`), it ends where it was opened.
 */
export function TutorialScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const navigation = useNavigation<NativeStackNavigationProp<AuthParams & RootParams>>();
  const replay = useRoute<RouteProp<RootParams, "tutorial">>().params?.replay === true;
  const list = useRef<FlatList<(typeof TUTORIAL)[number]>>(null);
  const [page, setPage] = useState(0);
  const last = page === TUTORIAL.length - 1;

  const finish = () => (replay ? navigation.goBack() : navigation.navigate("signUp"));
  const turn = (to: number) => {
    list.current?.scrollToIndex({ index: to, animated: true });
    setPage(to);
  };

  return (
    // Seen again from Help it is a full-screen modal, where the live safe area reads zero.
    <FullScreen color={c.bg}>
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          onPress={() => (page > 0 ? turn(page - 1) : navigation.goBack())}
          style={styles.back}
        >
          <ChevronLeft size={26} color={c.ink} />
        </Pressable>
        <Button variant="ghost" size="sm" label={t("tutorial.skip")} onPress={finish} />
      </View>
      <FlatList
        ref={list}
        data={TUTORIAL}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.title}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <View style={styles.picture}>
              <Sticker icon={item.icon} color={c[item.color]} size={184} />
              <View style={[styles.chip, { backgroundColor: c.surface, borderColor: c.onPastel }]}>
                <Text variant="smallStrong" style={{ color: c.ink }}>
                  {t(item.chip)}
                </Text>
              </View>
            </View>
            <Text variant="title" style={styles.center}>
              {t(item.title)}
            </Text>
            <Text tone="body" style={[styles.center, styles.text]}>
              {t(item.text)}
            </Text>
          </View>
        )}
      />
      <View style={styles.dots} accessibilityRole="progressbar" accessibilityLabel={t("tutorial.page", { page: page + 1, count: TUTORIAL.length })}>
        {TUTORIAL.map((item, i) => (
          <View key={item.title} style={[styles.dot, i === page ? { width: 24, backgroundColor: c.ink } : { backgroundColor: c.lineStrong }]} />
        ))}
      </View>
      <View style={styles.actions}>
        <Button
          label={last ? (replay ? t("tutorial.done") : t("signUp.submit")) : t("tutorial.next")}
          onPress={() => (last ? finish() : turn(page + 1))}
        />
      </View>
    </FullScreen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingRight: 16, minHeight: 52 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  page: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, gap: 14 },
  picture: { marginBottom: 28 },
  chip: { position: "absolute", top: -14, right: -18, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.m, borderWidth: hairline + 0.5 },
  center: { textAlign: "center" },
  text: { maxWidth: 320 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, paddingVertical: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { paddingHorizontal: 24, paddingBottom: 16 },
});
