import type { AttendeeStatus } from "@ruchoir/client";
import { Check, HelpCircle, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Text } from "../../ui/Text";

export type Answer = Exclude<AttendeeStatus, "needs_action">;

/** Yes, Maybe, No (the web's answer buttons): the answer given filled in its colour. */
export function AnswerButtons({ value, disabled, onAnswer }: { value?: AttendeeStatus; disabled?: boolean; onAnswer: (answer: Answer) => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const answers = [
    { status: "accepted", label: t("calendar.answer.accepted"), icon: Check, color: c.lime },
    { status: "tentative", label: t("event.maybe"), icon: HelpCircle, color: c.sun },
    { status: "declined", label: t("event.no"), icon: X, color: c.peach },
  ] as const;
  return (
    <View style={styles.row}>
      {answers.map(({ status, label, icon: Icon, color }) => {
        const on = value === status;
        return (
          <Pressable
            key={status}
            accessibilityRole="button"
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onAnswer(status)}
            style={({ pressed }) => [
              styles.answer,
              { borderColor: on ? c.ink : c.controlLine, backgroundColor: on ? color : c.surface },
              (pressed || disabled) && { opacity: 0.6 },
            ]}
          >
            <Icon size={16} color={on ? c.onPastel : c.ink} />
            <Text variant="smallStrong" numberOfLines={1} style={{ color: on ? c.onPastel : c.ink }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  answer: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 40, borderRadius: radius.m, borderWidth: hairline },
});
