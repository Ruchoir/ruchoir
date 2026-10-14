import { Eye, EyeOff } from "lucide-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import { useTranslation } from "../i18n";
import { fonts } from "../theme/fonts";
import { hairline, radius } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { Text } from "./Text";

/**
 * A labelled field: 52px tall, 16px text (below that, iOS zooms in on focus), the control outline of
 * the design system. A secret field gets the eye that shows what was typed.
 */
export function TextField({
  label,
  hint,
  error,
  secret,
  ...input
}: TextInputProps & { label: string; hint?: string; error?: string; secret?: boolean }) {
  const { c, s } = useTheme();
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeOff : Eye;

  return (
    <View style={styles.field}>
      <Text variant="smallStrong">{label}</Text>
      <View>
        <TextInput
          placeholderTextColor={c.muted}
          {...input}
          secureTextEntry={secret && !shown}
          style={[
            styles.input,
            { borderColor: error ? s.danger : c.controlLine, backgroundColor: c.surface, color: c.ink },
            secret && styles.withEye,
          ]}
        />
        {secret && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={shown ? t("field.hidePassword") : t("field.showPassword")}
            onPress={() => setShown((v) => !v)}
            style={styles.eye}
          >
            <Icon size={20} color={c.muted} />
          </Pressable>
        )}
      </View>
      {error ? (
        <Text variant="tiny" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="tiny" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  input: {
    height: 52,
    paddingHorizontal: 14,
    borderRadius: radius.m,
    borderWidth: hairline,
    fontSize: 16,
    fontFamily: fonts.sans,
  },
  withEye: { paddingRight: 52 },
  eye: { position: "absolute", right: 4, top: 4, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
