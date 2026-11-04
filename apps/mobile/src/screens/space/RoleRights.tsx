/**
 * The Droits tab of a role's editor (mockup frame 5): the catalogue by family, each right with its
 * sentence and its switch, a changed row tinted, a right the caller does not hold locked with its
 * reason, the guests' ceiling above their list. Switching only edits the draft; the save bar saves.
 */
import { FAMILY_TEXT, PERMISSION_TEXT } from "@ruchoir/client/permissionsLogic";
import { Lock } from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { useSharedT } from "../../i18n/sharedT";
import type { EditorRow } from "../../logic/roleEditor";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Text } from "../../ui/Text";
import { Toggle } from "../../ui/Toggle";
import { CeilingSummary } from "./CeilingSummary";

type Family = { key: keyof typeof FAMILY_TEXT; rows: EditorRow[] };

export function RoleRights({ families, guests, editable, onToggle }: { families: Family[]; guests: boolean; editable: boolean; onToggle: (permission: string, on: boolean) => void }) {
  const { t } = useTranslation();
  const shared = useSharedT();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <Text variant="small" tone="muted" style={styles.intro}>
        {guests ? t("roles.guestsIntro") : t("roles.rightsIntro")}
      </Text>
      {guests ? <CeilingSummary /> : null}
      {families.map((family) => (
        <View key={family.key}>
          <Text variant="label" tone="muted" style={styles.family}>
            {shared(FAMILY_TEXT[family.key])}
          </Text>
          {family.rows.map((row) => {
            const text = PERMISSION_TEXT[row.permission];
            return (
              <View key={row.permission} style={[styles.row, row.changed && { backgroundColor: s.selected }]}>
                <View style={styles.text}>
                  <Text variant="bodyStrong">{shared(text.title)}</Text>
                  <Text variant="tiny" tone="muted">
                    {shared(text.desc)}
                  </Text>
                  {row.lock ? (
                    <View style={styles.hint}>
                      <Lock size={12} color={c.muted} />
                      <Text variant="tiny" tone="muted" style={styles.hintText}>
                        {row.lock === "ceiling" ? t("roles.neverForGuests") : editable ? t("roles.notHeld") : ""}
                      </Text>
                    </View>
                  ) : null}
                  {row.givenByMembers ? (
                    <Text variant="tiny" tone="link">
                      {t("roles.givenByMembers")}
                    </Text>
                  ) : null}
                </View>
                <Toggle
                  accessibilityLabel={shared(text.title)}
                  value={row.on}
                  disabled={!editable || row.lock !== null}
                  onValueChange={(on) => onToggle(row.permission, on)}
                />
              </View>
            );
          })}
        </View>
      ))}
    </>
  );
}

const makeStyles = styleCache(() =>
  StyleSheet.create({
    intro: { paddingHorizontal: 16, paddingVertical: 10 },
    family: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
    text: { flex: 1, minWidth: 0, gap: 2 },
    hint: { flexDirection: "row", alignItems: "center", gap: 5 },
    hintText: { flex: 1 },
  }),
);
