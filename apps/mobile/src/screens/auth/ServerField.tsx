import { Server } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";

/** What the person sees of an origin: its host. */
export const hostOf = (origin: string) => origin.replace(/^https:\/\//, "");

/**
 * The server a form talks to: a row with "Change" once chosen, the address field while it is being
 * changed or before any. Shared by sign-in and sign-up, which check the address before going on.
 */
export function ServerField({
  server,
  editing,
  draft,
  onDraft,
  onEdit,
}: {
  server: string | null;
  editing: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  if (server && !editing) {
    return (
      <View style={[styles.row, { backgroundColor: s.sunken }]}>
        <Server size={18} color={c.ink} />
        <View style={styles.text}>
          <Text variant="tiny" tone="muted">
            {t("signIn.server")}
          </Text>
          <Text variant="bodyStrong" numberOfLines={1}>
            {hostOf(server)}
          </Text>
        </View>
        <Button variant="ghost" size="sm" label={t("signIn.change")} onPress={onEdit} />
      </View>
    );
  }
  return (
    <TextField
      label={t("signIn.serverField")}
      hint={t("signIn.serverHint")}
      placeholder={t("signIn.serverPlaceholder")}
      value={draft}
      onChangeText={onDraft}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="url"
      textContentType="URL"
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.m },
  text: { flex: 1, minWidth: 0 },
});
