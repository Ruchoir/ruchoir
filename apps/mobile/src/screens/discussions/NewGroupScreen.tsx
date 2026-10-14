/**
 * "Create a group": a channel of the space. Its name is shown as it will be written (`#projets-
 * clients`), it is open to the whole space or on invitation, and people can be added at once.
 */
import { addChannelMembers, createChannel, getChannels, type Member } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { channelHandle } from "../../logic/handle";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { SearchField } from "../../ui/SearchField";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { PeopleList } from "./PeopleList";

type Access = "public" | "private";

export function NewGroupScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user : null;
  const { current } = useSpace();
  const space = current?.id;
  const members = useSpaceMembers(space);
  const channels = useLoad(space ? `channels:${space}` : null, (signal) => getChannels(space!, signal));
  const people = members.list.filter((m) => m.userId !== me?.id && !m.bot);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [access, setAccess] = useState<Access>("public");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handle = channelHandle(name);
  const taken = !!handle && !!channels.data?.some((ch) => channelHandle(ch.name) === handle);
  const toggle = (member: Member) =>
    setChosen((prev) => (prev.includes(member.userId) ? prev.filter((id) => id !== member.userId) : [...prev, member.userId]));

  const create = async () => {
    if (!space || !handle || taken) return;
    setBusy(true);
    setFailed(false);
    let channel;
    try {
      channel = await createChannel(space, { name: name.trim(), type: access, topic: topic.trim() || undefined });
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    let everyone = true;
    if (chosen.length > 0) {
      try {
        await addChannelMembers(channel.id, chosen);
      } catch {
        everyone = false;
      }
    }
    navigation.goBack();
    navigation.navigate("conversation", { conversationId: channel.id, title: channel.name, channelId: channel.id, kind: "channel" });
    if (!everyone) toast(t("group.membersFailed"));
  };

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("newMessage.group")} onClose={() => navigation.goBack()} />
      <KeyboardArea style={styles.fill}>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.form}>
          <View style={styles.gutter}>
            <TextField
              label={t("group.name")}
              placeholder={t("group.namePlaceholder")}
              value={name}
              onChangeText={setName}
              autoFocus
              autoCapitalize="sentences"
              returnKeyType="next"
              error={taken ? t("group.taken") : undefined}
              hint={handle ? t("group.handle", { handle: `#${handle}` }) : undefined}
            />
          </View>
          <View style={styles.block}>
            <Text variant="smallStrong" style={styles.gutter}>
              {t("group.access")}
            </Text>
            <Segmented
              options={[
                { key: "public", label: t("group.open") },
                { key: "private", label: t("group.private") },
              ]}
              value={access}
              onChange={setAccess}
            />
            <Text variant="tiny" tone="muted" style={styles.gutter}>
              {access === "public" ? t("group.openHint") : t("group.privateHint")}
            </Text>
          </View>
          <View style={styles.gutter}>
            <TextField label={t("group.topic")} placeholder={t("group.topicPlaceholder")} value={topic} onChangeText={setTopic} />
          </View>
          <View style={styles.block}>
            <Text variant="smallStrong" style={styles.gutter}>
              {t("group.members")}
            </Text>
            <SearchField value={query} onChange={setQuery} placeholder={t("people.search")} />
            <PeopleList people={people} query={query} selected={chosen} onToggle={toggle} />
          </View>
        </ScrollView>
        <View style={[styles.foot, { borderTopColor: c.line }]}>
          {failed ? (
            <Text variant="small" tone="danger">
              {t("group.failed")}
            </Text>
          ) : null}
          <Button label={t("group.create")} disabled={!handle || taken} busy={busy} onPress={() => void create()} />
        </View>
      </KeyboardArea>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 20, paddingBottom: 24 },
  gutter: { paddingHorizontal: 16 },
  block: { gap: 8 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
