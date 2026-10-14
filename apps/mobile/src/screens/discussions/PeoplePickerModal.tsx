/**
 * Choosing people for a group, in a sheet of its own: a search and the space's people, drawn as they
 * scroll by. Kept out of the group's form, which then fits on one screen.
 */
import type { Member } from "@ruchoir/client";
import { useState } from "react";
import { Modal, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { PeopleList } from "./PeopleList";

export function PeoplePickerModal({
  title,
  people,
  selected,
  onDone,
  onClose,
}: {
  title: string;
  people: Member[];
  selected: string[];
  onDone: (selected: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(selected);
  const toggle = (member: Member) =>
    setPicked((prev) => (prev.includes(member.userId) ? prev.filter((id) => id !== member.userId) : [...prev, member.userId]));

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: c.surface }]}>
        <SheetHeader title={title} onClose={onClose} />
        <View style={styles.search}>
          <SearchField value={query} onChange={setQuery} placeholder={t("people.search")} />
        </View>
        <KeyboardArea style={styles.fill} safeBottom>
          <PeopleList style={styles.fill} people={people} query={query} selected={picked} onToggle={toggle} />
          <View style={[styles.foot, { borderTopColor: c.line }]}>
            <Button label={t("group.pickDone")} onPress={() => onDone(picked)} />
          </View>
        </KeyboardArea>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  search: { paddingBottom: 8 },
  foot: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
