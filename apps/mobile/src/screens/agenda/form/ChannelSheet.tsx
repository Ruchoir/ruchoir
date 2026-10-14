import { listLinkableChannels, type LinkableChannel } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Check, Hash, Lock, MessageSquareOff } from "lucide-react-native";
import { Fragment } from "react";
import { StyleSheet } from "react-native";

import { useLoad } from "../../../data/useLoad";
import { useTranslation } from "../../../i18n";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Sheet } from "../../../ui/Sheet";
import { LoadState } from "../../../ui/States";
import { Text } from "../../../ui/Text";
import { updateDraft, useDraft } from "./draftStore";

/** The channel the event is shared in: those its calendar may link to, by space, or none. */
export function ChannelSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventChannel">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const draft = useDraft(params.formKey);
  const calendarId = draft?.calendarId;
  const channels = useLoad(calendarId ? `linkable:${calendarId}` : null, (signal) => listLinkableChannels(calendarId!, signal));
  if (!draft) return null;
  const choose = (channelId: string | null) => {
    updateDraft(params.formKey, (d) => ({ ...d, channelId, channelTouched: true }));
    navigation.goBack();
  };
  const bySpace = new Map<string, LinkableChannel[]>();
  for (const ch of channels.data ?? []) bySpace.set(ch.spaceName, [...(bySpace.get(ch.spaceName) ?? []), ch]);
  const tick = (on: boolean) => (on ? <Check size={20} color={c.ink} /> : undefined);
  return (
    <Sheet>
      <Text variant="heading">{t("eventForm.chooseChannel")}</Text>
      {!channels.data ? <LoadState error={channels.error} onRetry={channels.reload} /> : null}
      <ActionRow icon={MessageSquareOff} title={t("calendar.noChannel")} selected={!draft.channelId} trailing={tick(!draft.channelId)} onPress={() => choose(null)} />
      {[...bySpace.entries()].map(([space, list]) => (
        <Fragment key={space}>
          <Text variant="smallStrong" tone="muted" style={styles.group}>
            {space}
          </Text>
          {list.map((ch) => (
            <ActionRow
              key={ch.id}
              icon={ch.private ? Lock : Hash}
              tint={c.pink}
              title={ch.name}
              selected={ch.id === draft.channelId}
              trailing={tick(ch.id === draft.channelId)}
              onPress={() => choose(ch.id)}
            />
          ))}
        </Fragment>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: 10 },
});
