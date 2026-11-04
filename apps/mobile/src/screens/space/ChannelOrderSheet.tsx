/**
 * The order of the space's channels, for whoever holds `space.settings` (the web's sidebar lets them
 * drag or step a channel; here, arrows like the roles' Réordonner). Each step is saved at once, the
 * list shown ahead of the server's word and put back as the server holds it when it refuses.
 */
import { ArrowDown, ArrowUp, Hash } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { stepChannel } from "../../logic/channelOrder";
import { affects } from "../../realtime/events";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

export function ChannelOrderSheet() {
  const { getChannels, setChannelOrder } = useApi();
  const { t } = useTranslation();
  const { s } = useTheme();
  const toast = useToast();
  const { current } = useSpace();
  const space = current?.id;
  const channels = useLoad(space ? `channels:${space}` : null, (signal) => getChannels(space!, signal));
  useReloadOn((e) => !!space && affects.channels(e, space), channels.reload, 300);
  // My step shown ahead of the server's word, for as long as the list it was made on is the one held.
  const [moved, setMoved] = useState<{ base: unknown; ids: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const serverOrder = channels.data?.map((ch) => ch.id);
  const order = moved && moved.base === channels.data ? moved.ids : serverOrder;

  const byId = new Map((channels.data ?? []).map((ch) => [ch.id, ch]));

  const move = async (id: string, step: -1 | 1) => {
    if (!space || !order || busy) return;
    const next = stepChannel(order, id, step);
    if (!next) return;
    feel("choice");
    setMoved({ base: channels.data, ids: next });
    setBusy(true);
    try {
      await setChannelOrder(space, next);
    } catch {
      toast(t("spaceAdmin.channelOrderFailed"), "failure");
    } finally {
      setBusy(false);
      channels.reload();
    }
  };

  return (
    <Sheet>
      <Text variant="heading">{t("spaceAdmin.channelOrder")}</Text>
      <Text tone="muted" style={styles.sub}>
        {t("spaceAdmin.channelOrderHint")}
      </Text>
      {!channels.data || !order ? (
        <LoadState error={channels.error} onRetry={channels.reload} />
      ) : (
        <ScrollView>
          {order.flatMap((id, index) => {
            const ch = byId.get(id);
            if (!ch) return [];
            return [
              <ActionRow
                key={id}
                icon={Hash}
                tint={s.sunken}
                title={ch.name}
                trailing={
                  <View style={styles.arrows}>
                    <Arrow up enabled={index > 0 && !busy} label={t("spaceAdmin.channelMoveUp", { channel: ch.name })} onPress={() => void move(id, -1)} />
                    <Arrow up={false} enabled={index < order.length - 1 && !busy} label={t("spaceAdmin.channelMoveDown", { channel: ch.name })} onPress={() => void move(id, 1)} />
                  </View>
                }
              />,
            ];
          })}
        </ScrollView>
      )}
    </Sheet>
  );
}

function Arrow({ up, enabled, label, onPress }: { up: boolean; enabled: boolean; label: string; onPress: () => void }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={4}
      onPress={onPress}
      style={[styles.arrow, { borderColor: enabled ? c.ink : c.lineStrong, backgroundColor: c.surface }]}
    >
      <Icon size={18} color={enabled ? c.ink : c.muted} />
    </Pressable>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    arrow: { width: 36, height: 36, borderRadius: shape.radius.m, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  }),
);

const styles = StyleSheet.create({
  sub: { marginBottom: 6 },
  arrows: { flexDirection: "row", gap: 8 },
});
