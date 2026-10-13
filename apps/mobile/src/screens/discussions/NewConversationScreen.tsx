/**
 * "Write to a person": the space's people, a search, and "Write". One person opens the conversation
 * with them (the existing one if there is one); several make a group conversation.
 */
import { createDm, type Member } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useSpaceMembers } from "../../data/members";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { PeopleList } from "./PeopleList";

export function NewConversationScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const { current } = useSpace();
  const members = useSpaceMembers(current?.id);
  const people = members.list.filter((m) => m.userId !== me?.id && !m.bot);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = (member: Member) =>
    setChosen((prev) => (prev.some((m) => m.userId === member.userId) ? prev.filter((m) => m.userId !== member.userId) : [...prev, member]));

  const write = async () => {
    if (!current || chosen.length === 0) return;
    setBusy(true);
    setFailed(false);
    try {
      const conversationId = await createDm(
        current.id,
        chosen.map((m) => m.userId),
      );
      navigation.goBack();
      navigation.navigate("conversation", {
        conversationId,
        title: chosen.map((m) => m.name).join(", "),
        kind: chosen.length === 1 ? "person" : "group",
      });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const label =
    chosen.length === 0
      ? t("people.write")
      : chosen.length === 1
        ? t("people.writeTo", { name: chosen[0].name })
        : t("people.writeGroup", { count: chosen.length });

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("people.title")} onClose={() => navigation.goBack()} />
      <View style={styles.search}>
        <SearchField value={query} onChange={setQuery} placeholder={t("people.search")} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <PeopleList people={people} query={query} selected={chosen.map((m) => m.userId)} onToggle={toggle} />
      </ScrollView>
      <View style={[styles.foot, { borderTopColor: c.line }]}>
        {failed ? (
          <Text variant="small" tone="danger">
            {t("people.failed")}
          </Text>
        ) : null}
        <Button label={label} disabled={chosen.length === 0} busy={busy} onPress={() => void write()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  search: { paddingHorizontal: 16, paddingBottom: 8 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
