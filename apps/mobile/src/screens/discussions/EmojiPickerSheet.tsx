/**
 * Every emoji, to react with one: a search in the reader's language (French and English as a
 * fallback), and the categories as tabs. The same dataset and keywords as the web.
 */
import { EMOJI_CATEGORIES, searchEmojis } from "@ruchoir/client/emoji";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { SearchX } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useReact } from "../../compose/useReact";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import type { RootParams } from "../../navigation/types";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { SearchField } from "../../ui/SearchField";
import { EmptyState } from "../../ui/States";
import { Text } from "../../ui/Text";

const LABELS: Record<string, ReturnType<typeof key>> = {
  smileys: key("emoji.smileys"),
  gestures: key("emoji.gestures"),
  people: key("discussions.filterPeople"),
  hearts: key("emoji.hearts"),
  nature: key("emoji.nature"),
  food: key("emoji.food"),
  travel: key("emoji.travel"),
  activities: key("emoji.activities"),
  objects: key("emoji.objects"),
  symbols: key("emoji.symbols"),
};

const CELL = 48;

export function EmojiPickerSheet() {
  const { params } = useRoute<RouteProp<RootParams, "emojiPicker">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale } = useLocale();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const react = useReact();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0].id);
  const columns = Math.max(6, Math.floor((width - 32) / CELL));

  const shown = useMemo(
    () => (query.trim() ? searchEmojis(query, locale) : (EMOJI_CATEGORIES.find((cat) => cat.id === category)?.emojis ?? [])),
    [query, category, locale],
  );

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <View style={styles.head}>
        <Text variant="heading" style={styles.gutter}>
          {t("message.react")}
        </Text>
        <SearchField value={query} onChange={setQuery} placeholder={t("emoji.search")} />
        {query.trim() ? null : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
            {EMOJI_CATEGORIES.map((cat) => {
              const on = cat.id === category;
              return (
                <Pressable
                  key={cat.id}
                  accessibilityRole="tab"
                  accessibilityLabel={t(LABELS[cat.id])}
                  accessibilityState={{ selected: on }}
                  onPress={() => setCategory(cat.id)}
                  style={[styles.tab, { backgroundColor: on ? s.selected : "transparent", borderColor: on ? c.ink : "transparent" }]}
                >
                  <Text style={styles.tabGlyph}>{cat.icon}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
      <FlatList
        key={columns}
        data={shown}
        numColumns={columns}
        keyExtractor={(emoji) => emoji}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 16 }]}
        ListHeaderComponent={
          query.trim() ? null : (
            <Text variant="label" tone="muted" style={styles.section}>
              {t(LABELS[category])}
            </Text>
          )
        }
        ListEmptyComponent={<EmptyState size="compact" icon={SearchX} title={t("emoji.none")} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("message.reactWith", { emoji: item })}
            onPress={() => {
              react(params.conversationId, params.message, item);
              navigation.goBack();
            }}
            style={({ pressed }) => [styles.cell, pressed && { backgroundColor: s.pressed }]}
          >
            <Text style={styles.glyph}>{item}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  head: { paddingTop: 24, gap: 12 },
  gutter: { paddingHorizontal: 16 },
  tabsScroll: { flexGrow: 0 },
  tabs: { gap: 4, paddingHorizontal: 16 },
  tab: { width: 44, height: 44, borderRadius: radius.m, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  tabGlyph: { fontSize: 22, lineHeight: 28 },
  grid: { paddingHorizontal: 16 },
  section: { paddingTop: 12, paddingBottom: 4 },
  cell: { width: CELL, height: CELL, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
  glyph: { fontSize: 28, lineHeight: 34 },
});
