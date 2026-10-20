/**
 * Deleting the current space, its owner's last word: what goes (everything, for everyone, at once),
 * then the space's name to type, as on the web. A screen rather than an alert, since an alert cannot
 * hold a text field on Android.
 */
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { nameConfirmed } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

export function DeleteSpaceScreen() {
  const { deleteSpace } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { current, spaces } = useSpace();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  if (!current) return null;
  const confirmed = nameConfirmed(typed, current.name);
  // Said once what was typed is as long as the name: not while it is still being typed.
  const wrong = !confirmed && typed.trim().length >= current.name.trim().length;

  const remove = async () => {
    setBusy(true);
    try {
      await deleteSpace(current.id);
    } catch {
      setBusy(false);
      toast(t("spaceAdmin.deleteFailed"), "failure");
      return;
    }
    toast(t("spaceAdmin.deleted"));
    spaces.reload();
    navigation.popToTop();
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            <Button variant="danger" label={t("spaceAdmin.deleteConfirm")} onPress={() => void remove()} busy={busy} disabled={!confirmed} />
          </View>
        }
      >
        <SheetHeader title={t("spaceAdmin.deleteTitle", { name: current.name })} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          <Text tone="body">{t("spaceAdmin.deleteBody")}</Text>
          <TextField
            label={t("spaceAdmin.deleteLabel", { name: current.name })}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            error={wrong ? t("spaceAdmin.deleteMismatch") : undefined}
          />
        </View>
      </KeyboardForm>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 24 },
  pad: { paddingHorizontal: 20, gap: 16 },
  footer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 },
});
