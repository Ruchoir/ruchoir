/**
 * The Nom tab of a role's editor (mockup frame 5, left): its name, its colour among the seven the
 * server accepts, and where rules still name it (shown once the server refused to delete it for that).
 */
import { ROLE_NAME_MAX, type UsedInRow } from "@ruchoir/client/permissionsLogic";
import { Calendar, File, Hash } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useSharedT } from "../../i18n/sharedT";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { RoleColours } from "./RoleColours";

/** A role's name is 1 to 40 characters (the API's rule, the web's field). */
export const NAME_MAX = ROLE_NAME_MAX;

const KIND_ICON = { channel: Hash, file: File, calendar: Calendar } as const;

export function RoleName({
  name,
  colour,
  editable,
  error,
  usedIn,
  roleName,
  onName,
  onColour,
}: {
  name: string;
  colour: string;
  editable: boolean;
  error?: string;
  usedIn: UsedInRow[] | null;
  roleName: string;
  onName: (name: string) => void;
  onColour: (colour: string) => void;
}) {
  const { t } = useTranslation();
  const shared = useSharedT();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.box}>
      <TextField label={t("files.name")} value={name} onChangeText={onName} editable={editable} maxLength={NAME_MAX} showCount error={error} autoCapitalize="sentences" />
      <RoleColours colour={colour} editable={editable} onColour={onColour} />
      {usedIn ? (
        <View style={styles.used}>
          <Text variant="small" tone="body" accessibilityRole="alert">
            <Text variant="smallStrong">{t("access.usedIn.warnTitle", { name: roleName })}</Text> {t("access.usedIn.warnBody")}
          </Text>
          <Text variant="label" tone="muted">
            {t("access.usedIn.where")}
          </Text>
          {usedIn.map((row, i) => {
            const Icon = KIND_ICON[row.kind];
            return (
              <View key={`${row.kind}:${row.id ?? i}`} style={styles.usedRow}>
                <View style={[styles.tile, { backgroundColor: s.sunken, borderColor: c.line }]}>
                  <Icon size={18} color={c.body} />
                </View>
                <View style={styles.usedText}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {row.hidden ? t("access.usedIn.hidden") : row.label}
                  </Text>
                  <Text variant="tiny" tone="muted">
                    {[shared(row.kindKey), row.levelKey ? shared(row.levelKey) : null].filter(Boolean).join(" · ")}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    box: { gap: 16, padding: 16 },
    used: { gap: 8, paddingTop: 8 },
    usedRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
    tile: { width: 40, height: 40, borderRadius: shape.radius.m, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    usedText: { flex: 1, minWidth: 0 },
  }),
);
