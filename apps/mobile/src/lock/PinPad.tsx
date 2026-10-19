/**
 * The lock's PIN screen (`lock/AppLock.tsx`): the mark, what is asked, six dots, and a keypad of its
 * own, so the phone's keyboard never comes up over a lock. The key left of 0 asks for Face ID again
 * when the phone has it; the line under the title says what went wrong (a wrong PIN, the attempts
 * left). Below the keypad, the screen's own way out: cancel, or "Forgot your PIN?".
 */
import { Delete, FingerprintPattern, ScanFace } from "lucide-react-native";
import type { ReactNode } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslation } from "../i18n";
import type { BiometryKind } from "../logic/lock";
import { PIN_LENGTH } from "../logic/pin";
import { useTheme } from "../theme/useTheme";
import { Button } from "../ui/Button";
import { Text } from "../ui/Text";

const mark = require("../../assets/mark.png");

const ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

export function PinScreen({
  title,
  message,
  error = false,
  entry,
  onKey,
  biometry,
  onBiometry,
  busy = false,
  action,
}: {
  title: string;
  /** A hint, or what went wrong (`error`). */
  message?: string;
  error?: boolean;
  entry: string;
  onKey: (key: string) => void;
  /** Face ID again, on the key left of 0, when the phone has biometrics. */
  biometry?: BiometryKind | null;
  onBiometry?: () => void;
  /** Checking the PIN: the keys wait. */
  busy?: boolean;
  /** The way out under the keypad (cancel, forgot), when there is one. */
  action?: { label: string; onPress: () => void };
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const BiometryIcon = biometry === "faceId" ? ScanFace : FingerprintPattern;
  return (
    <SafeAreaView style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}>
      <View style={styles.head}>
        <Image source={mark} style={[styles.mark, { tintColor: c.brand }]} accessibilityIgnoresInvertColors />
        <Text variant="heading" style={styles.center} accessibilityRole="header">
          {title}
        </Text>
        <Text variant="small" tone={error ? "danger" : "muted"} style={[styles.center, styles.message]} accessibilityLiveRegion="polite">
          {message ?? " "}
        </Text>
        <View style={styles.dots} accessible accessibilityLabel={t("lock.typed", { count: entry.length, total: PIN_LENGTH })}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <View
              key={i}
              style={[styles.dot, { borderColor: error ? s.danger : c.ink }, i < entry.length && { backgroundColor: error ? s.danger : c.ink }]}
            />
          ))}
        </View>
      </View>
      <View style={styles.pad}>
        {ROWS.map((row) => (
          <View key={row[0]} style={styles.row}>
            {row.map((digit) => (
              <Key key={digit} label={digit} disabled={busy} onPress={() => onKey(digit)}>
                <Text variant="title">{digit}</Text>
              </Key>
            ))}
          </View>
        ))}
        <View style={styles.row}>
          {biometry && onBiometry ? (
            <Key label={t(biometry === "faceId" ? "lock.unlockFaceId" : biometry === "touchId" ? "lock.unlockTouchId" : "lock.unlock")} plain disabled={busy} onPress={onBiometry}>
              <BiometryIcon size={30} color={c.ink} />
            </Key>
          ) : (
            <View style={styles.key} />
          )}
          <Key label="0" disabled={busy} onPress={() => onKey("0")}>
            <Text variant="title">0</Text>
          </Key>
          <Key label={t("lock.erase")} plain disabled={busy || entry.length === 0} onPress={() => onKey("erase")}>
            <Delete size={28} color={entry.length === 0 ? c.muted : c.ink} />
          </Key>
        </View>
      </View>
      <View style={styles.actions}>{action ? <Button variant="ghost" label={action.label} onPress={action.onPress} /> : null}</View>
    </SafeAreaView>
  );
}

function Key({
  label,
  onPress,
  disabled,
  plain = false,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** No disc behind it: Face ID and erase. */
  plain?: boolean;
  children: ReactNode;
}) {
  const { c, s } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.key, !plain && { backgroundColor: c.surface, borderColor: c.line }, !plain && styles.disc, pressed && { backgroundColor: s.pressed }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flex: 1, alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 24, gap: 8 },
  mark: { width: 44, height: 44, marginBottom: 8 },
  center: { textAlign: "center" },
  message: { minHeight: 18 },
  dots: { flexDirection: "row", gap: 16, marginTop: 12, marginBottom: 28 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  pad: { alignItems: "center", gap: 14 },
  row: { flexDirection: "row", gap: 24 },
  key: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  disc: { borderWidth: 1 },
  actions: { minHeight: 64, justifyContent: "center", paddingHorizontal: 20, paddingVertical: 8 },
});
