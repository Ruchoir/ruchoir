/**
 * "Create a group": a channel of the space. Its name is shown as it will be written (`#projets-
 * clients`), it is open to the whole space or on invitation, and people can be added at once.
 */
import { addChannelMembers, createChannel, getChannels, inviteToChannel } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { ChevronRight, UserPlus, X } from "lucide-react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { addAddress, isEmail } from "../../logic/email";
import { channelHandle } from "../../logic/handle";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { AvatarStack } from "../../ui/AvatarStack";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { KeyboardScroll } from "../../ui/KeyboardScroll";
import { PeoplePickerModal } from "./PeoplePickerModal";

type Access = "public" | "private";

export function NewGroupScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
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
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  // People from outside, by address: invited as guests who see this group only.
  const [address, setAddress] = useState("");
  const [outsiders, setOutsiders] = useState<string[]>([]);
  const [addressError, setAddressError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handle = channelHandle(name);
  const taken = !!handle && !!channels.data?.some((ch) => channelHandle(ch.name) === handle);
  const addOutsider = () => {
    if (!address.trim()) return;
    if (!isEmail(address)) {
      setAddressError(true);
      return;
    }
    setOutsiders((prev) => addAddress(prev, address));
    setAddress("");
  };
  const chosenMembers = chosen.flatMap((id) => people.filter((m) => m.userId === id));

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
    // People of the space are chosen only for a group on invitation: an open one is everyone's.
    if (access === "private" && chosen.length > 0) {
      try {
        await addChannelMembers(channel.id, chosen);
      } catch {
        everyone = false;
      }
    }
    // An address typed but not added yet is meant too.
    const addresses = isEmail(address) ? addAddress(outsiders, address) : outsiders;
    const invited = await Promise.allSettled(addresses.map((a) => inviteToChannel(channel.id, a)));
    const unsent = invited.filter((r) => r.status === "rejected").length;
    navigation.goBack();
    navigation.navigate("conversation", { conversationId: channel.id, title: channel.name, channelId: channel.id, kind: "channel" });
    if (!everyone) toast(t("group.membersFailed"));
    else if (unsent > 0) toast(t("group.invitesFailed", { count: unsent }));
    else if (addresses.length > 0) toast(t("group.invitesSent", { count: addresses.length }));
  };

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("newMessage.group")} onClose={() => navigation.goBack()} />
      <KeyboardArea style={styles.fill}>
        {/* Short enough to fit on one screen: the name, who can join, the people (picked in a
            sheet of their own), people from outside, and the optional topic last. */}
        <KeyboardScroll style={styles.fill} keyboardDismissMode="on-drag" contentContainerStyle={styles.form}>
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
          {access === "private" ? (
            <View style={[styles.block, styles.gutter]}>
              <Text variant="smallStrong">{t("group.members")}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPicking(true)}
                style={({ pressed }) => [styles.pick, { borderColor: c.controlLine, backgroundColor: c.surface }, pressed && { opacity: 0.7 }]}
              >
                {chosenMembers.length > 0 ? (
                  <AvatarStack size={36} people={chosenMembers.map((m) => ({ name: m.name, avatarUrl: m.avatarUrl }))} />
                ) : (
                  <View style={[styles.pickTile, { backgroundColor: s.sunken }]}>
                    <UserPlus size={18} color={c.ink} />
                  </View>
                )}
                <View style={styles.grow}>
                  <Text variant="bodyStrong">
                    {chosen.length > 0 ? t("group.picked", { count: chosen.length }) : t("group.pickPeople")}
                  </Text>
                  {chosenMembers.length > 0 ? (
                    <Text variant="tiny" tone="muted" numberOfLines={1}>
                      {chosenMembers.map((m) => m.name).join(", ")}
                    </Text>
                  ) : null}
                </View>
                <ChevronRight size={18} color={c.muted} />
              </Pressable>
            </View>
          ) : null}
          <View style={[styles.block, styles.gutter]}>
            <Text variant="smallStrong">{t("group.externals")}</Text>
            <View style={styles.addRow}>
              <View style={styles.grow}>
                <TextField
                  label={t("signIn.email")}
                  value={address}
                  onChangeText={(text) => {
                    setAddress(text);
                    setAddressError(false);
                  }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={addOutsider}
                  error={addressError ? t("invite.invalidEmail") : undefined}
                  hint={t("group.externalsHint")}
                />
              </View>
              <Button variant="secondary" size="md" label={t("group.addExternal")} disabled={!address.trim()} onPress={addOutsider} style={styles.addButton} />
            </View>
            {outsiders.length > 0 ? (
              <View style={styles.chips}>
                {outsiders.map((a) => (
                  <View key={a} style={[styles.chip, { backgroundColor: s.sunken }]}>
                    <Text variant="small" numberOfLines={1} style={styles.chipText}>
                      {a}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("attach.remove", { name: a })}
                      hitSlop={8}
                      onPress={() => setOutsiders((prev) => prev.filter((x) => x !== a))}
                    >
                      <X size={14} color={c.ink} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
          <View style={styles.gutter}>
            <TextField label={t("group.topic")} placeholder={t("group.topicPlaceholder")} value={topic} onChangeText={setTopic} />
          </View>
        </KeyboardScroll>
        <View style={[styles.foot, { borderTopColor: c.line }]}>
          {failed ? (
            <Text variant="small" tone="danger">
              {t("group.failed")}
            </Text>
          ) : null}
          <Button label={t("group.create")} disabled={!handle || taken} busy={busy} onPress={() => void create()} />
        </View>
      </KeyboardArea>
      {picking ? (
        <PeoplePickerModal
          title={t("group.members")}
          people={people}
          selected={chosen}
          onDone={(ids) => {
            setChosen(ids);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 20, paddingBottom: 24 },
  gutter: { paddingHorizontal: 16 },
  block: { gap: 8 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
  addRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  grow: { flex: 1 },
  // Level with the field, under its label.
  addButton: { marginTop: 24, height: 52 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingLeft: 10, paddingRight: 8, paddingVertical: 6, borderRadius: radius.l },
  chipText: { flexShrink: 1 },
  pick: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, borderWidth: hairline, borderRadius: radius.m },
  pickTile: { width: 36, height: 36, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
});
