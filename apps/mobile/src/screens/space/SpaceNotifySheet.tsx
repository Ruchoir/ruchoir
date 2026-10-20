/**
 * How much the current space notifies me, the web's "Space notifications": the four levels of a
 * conversation, saved the moment one is chosen. "Default" follows the account's preferences.
 */
import type { NotifyLevel } from "@ruchoir/client";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { key, useTranslation } from "../../i18n";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

const LEVELS: { level: NotifyLevel; label: ReturnType<typeof key>; hint: ReturnType<typeof key> }[] = [
  { level: "default", label: key("details.levelDefault"), hint: key("spaceAdmin.notifyDefaultHint") },
  { level: "all", label: key("details.levelAll"), hint: key("details.levelAllHint") },
  { level: "mentions", label: key("details.levelMentions"), hint: key("details.levelMentionsHint") },
  { level: "none", label: key("details.levelNone"), hint: key("details.levelNoneHint") },
];

export function SpaceNotifySheet() {
  const { saveSpaceNotify } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const { current, spaces } = useSpace();
  // What I chose here, ahead of what the server last said.
  const [chosen, setChosen] = useState<NotifyLevel | null>(null);
  if (!current) return null;
  const level = chosen ?? current.notifyLevel;

  const save = (next: NotifyLevel) => {
    if (next === level) return;
    feel("choice");
    const before = level;
    setChosen(next);
    saveSpaceNotify(current.id, next).then(spaces.reload, () => {
      setChosen(before);
      toast(t("details.saveFailed"), "failure");
    });
  };

  return (
    <Sheet>
      <Text variant="heading">{t("spaceAdmin.notifications")}</Text>
      <Text tone="muted" style={styles.sub}>
        {current.name}
      </Text>
      {LEVELS.map(({ level: value, label, hint }) => {
        const on = value === level;
        return (
          <ActionRow
            key={value}
            title={t(label)}
            subtitle={t(hint)}
            selected={on}
            onPress={() => save(value)}
            trailing={
              <View style={[styles.radio, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>
                {on ? <Check size={14} color={c.onInk} /> : null}
              </View>
            }
          />
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sub: { marginBottom: 6 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
});
