/**
 * The current space's default channel, the one every newly invited person joins first: chosen among
 * its public channels, by its owner or an admin (the web's "default channel" setting).
 */
import { useNavigation } from "@react-navigation/native";
import { Check, Hash } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

export function DefaultChannelSheet() {
  const { getChannels, setDefaultChannel } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const toast = useToast();
  const navigation = useNavigation();
  const { current, spaces } = useSpace();
  const space = current?.id;
  const channels = useLoad(space ? `channels:${space}` : null, (signal) => getChannels(space!, signal));
  const [busy, setBusy] = useState(false);
  const open = channels.data?.filter((ch) => ch.type === "public");

  const choose = async (channelId: string) => {
    if (!space || busy) return;
    if (channelId === current?.defaultChannelId) {
      navigation.goBack();
      return;
    }
    feel("choice");
    setBusy(true);
    try {
      await setDefaultChannel(space, channelId);
      spaces.reload();
      toast(t("spaceAdmin.defaultChannelUpdated"));
      navigation.goBack();
    } catch {
      toast(t("spaceAdmin.defaultChannelFailed"), "failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet>
      <Text variant="heading">{t("spaceAdmin.defaultChannel")}</Text>
      <Text tone="muted" style={styles.sub}>
        {t("spaceAdmin.defaultChannelHint")}
      </Text>
      {!open ? (
        <LoadState error={channels.error} onRetry={channels.reload} />
      ) : (
        <ScrollView>
          {open.map((ch) => {
            const on = ch.id === current?.defaultChannelId;
            return (
              <ActionRow
                key={ch.id}
                icon={Hash}
                tint={on ? c.sky : s.sunken}
                title={ch.name}
                subtitle={ch.topic}
                selected={on}
                onPress={() => void choose(ch.id)}
                trailing={on ? <Check size={20} color={c.ink} /> : undefined}
              />
            );
          })}
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sub: { marginBottom: 6 },
});
