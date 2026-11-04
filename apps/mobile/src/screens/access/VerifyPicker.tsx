/**
 * "Vérifier l'accès de quelqu'un": pick one person, then "Pourquoi ?" explains for them, step by
 * step, why they have (or lack) access. A sheet of its own: the web picks in a select, a phone in a list.
 */
import type { Member } from "@ruchoir/client";
import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { verifyPeople } from "../../logic/accessScreen";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { filterPeople } from "../discussions/PeopleList";

export function VerifyPicker({ people, onPick, onClose }: { people: Member[]; onPick: (member: Member) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState("");
  const shown = filterPeople(verifyPeople(people), query);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: c.surface }]}>
        <SheetHeader title={t("access.verifyTitle")} onClose={onClose} />
        <View style={styles.search}>
          <SearchField value={query} onChange={setQuery} placeholder={t("people.search")} />
        </View>
        <KeyboardArea style={styles.fill} safeBottom>
          <FlatList
            style={styles.fill}
            data={shown}
            keyExtractor={(m) => m.userId}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable accessibilityRole="button" onPress={() => onPick(item)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: s.pressed }]}>
                <Avatar name={item.name} src={item.avatarUrl} size={40} />
                <View style={styles.text}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.title ? (
                    <Text variant="tiny" tone="muted" numberOfLines={1}>
                      {item.title}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            )}
          />
        </KeyboardArea>
      </View>
    </Modal>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    fill: { flex: 1 },
    search: { paddingBottom: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    text: { flex: 1, minWidth: 0 },
  }),
);
