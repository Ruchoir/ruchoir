/**
 * "Edit the channel", from a channel's details: its name, its topic, who may join it, and whether it
 * is archived (read-only, nothing deleted), as the web's channel settings. The API decides who may
 * change what; a refusal is said, and the details reload from the live `channels` event.
 */
import { getChannels, isApiError, updateChannel, type ChannelType } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { channelHandle } from "../../logic/handle";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";
import { Toggle } from "../../ui/Toggle";

type Access = "public" | "private";

export function ChannelEditScreen() {
  const { params } = useRoute<RouteProp<RootParams, "channelEdit">>();
  const navigation = useNavigation();
  const { current } = useSpace();
  const space = current?.id;
  const channels = useLoad(space ? `channels:${space}` : null, (signal) => getChannels(space!, signal));
  const channel = channels.data?.find((ch) => ch.id === params.channelId);
  const { t } = useTranslation();
  const { c } = useTheme();
  if (!channel) {
    return (
      <View style={[styles.fill, { backgroundColor: c.surface }]}>
        <SheetHeader title={t("details.edit")} onClose={() => navigation.goBack()} />
        <LoadState error={channels.error} onRetry={channels.reload} />
      </View>
    );
  }
  const taken = (channels.data ?? []).filter((ch) => ch.id !== channel.id).map((ch) => channelHandle(ch.name));
  return <Form channelId={channel.id} name={channel.name} topic={channel.topic ?? ""} type={channel.type} taken={taken} />;
}

function Form({ channelId, name: initialName, topic: initialTopic, type, taken }: { channelId: string; name: string; topic: string; type: ChannelType; taken: string[] }) {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const { current } = useSpace();
  const { emit } = useRealtimeActions();
  const [name, setName] = useState(initialName);
  const [topic, setTopic] = useState(initialTopic);
  const [access, setAccess] = useState<Access>(type === "private" ? "private" : "public");
  const [archived, setArchived] = useState(type === "archived");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const handle = channelHandle(name);
  const clash = !!handle && taken.includes(handle);

  const save = async () => {
    if (!handle || clash) return;
    setBusy(true);
    setFailed(null);
    try {
      await updateChannel(channelId, { name: name.trim().replace(/^#/, ""), topic: topic.trim(), type: archived ? "archived" : access });
      feel("success");
      toast(t("channelEdit.saved"), "success");
      if (current) emit({ type: "channels", spaceId: current.id, channelId });
      navigation.goBack();
    } catch (err) {
      feel("failure");
      setFailed(isApiError(err, 403) ? t("channelEdit.forbidden") : isApiError(err, 400) ? t("group.taken") : t("channelEdit.failed"));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("details.edit")} onClose={() => navigation.goBack()} />
      <KeyboardForm
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.form}
        footer={
          <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
            {failed ? (
              <Text variant="small" tone="danger">
                {failed}
              </Text>
            ) : null}
            <Button label={t("compose.save")} disabled={!handle || clash} busy={busy} onPress={() => void save()} />
          </View>
        }
      >
        <View style={styles.gutter}>
          <TextField
            label={t("group.name")}
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            error={clash ? t("group.taken") : undefined}
            hint={handle ? t("group.handle", { handle: `#${handle}` }) : undefined}
          />
        </View>
        <View style={styles.gutter}>
          <TextField label={t("group.topic")} placeholder={t("group.topicPlaceholder")} value={topic} onChangeText={setTopic} />
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
          <ActionRow
            title={t("channelEdit.archive")}
            subtitle={t("channelEdit.archiveHint")}
            trailing={<Toggle value={archived} onValueChange={setArchived} accessibilityLabel={t("channelEdit.archive")} />}
          />
        </View>
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { gap: 20, paddingBottom: 24 },
  gutter: { paddingHorizontal: 16 },
  block: { gap: 8 },
  foot: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
