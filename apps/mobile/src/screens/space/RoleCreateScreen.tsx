/**
 * A new role (mockup frame 4, the floating button): its name and, optionally, the role it copies.
 * The API places it just below the caller's highest role; its rights and colour are tuned in its
 * editor, which opens next. Name limits and refusals are the web's.
 */
import { refusalOf } from "@ruchoir/client";
import { ROLE_NAME_MAX } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { roleColourKey } from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import { newRoleColour } from "../../logic/roleEditor";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { RoleDot } from "../../ui/RoleChip";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { RoleColours } from "./RoleColours";

/** A role's name is 1 to 40 characters (the API's rule, the web's field). */
const NAME_MAX = ROLE_NAME_MAX;

export function RoleCreateScreen() {
  const { listRoles, createRole } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { current } = useSpace();
  const roles = useLoad(current ? `roles:${current.id}` : null, () => listRoles(current!.id));
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [colour, setColour] = useState("mint");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  if (!current) return null;
  // The web's rule: a role of their own that the caller manages.
  const copyable = (roles.data ?? []).filter((r) => r.manageable && !r.systemKey);
  const trimmed = name.trim();

  // Copying a role takes its colour to start from (the person can still change it).
  const pickSource = (id: string | null) => {
    setCopyFrom(id);
    setColour(newRoleColour(roles.data ?? [], id));
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const role = await createRole(current.id, { name: trimmed, colour, copyFrom: copyFrom ?? undefined });
      feel("success");
      // The editor replaces this sheet: leaving it back goes to the list.
      navigation.goBack();
      navigation.navigate("roleEditor", { roleId: role.id });
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      setError(said ? String(t(said.key as never, said.vars as never)) : t("roles.saveFailed"));
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            <Button label={t("roles.createAndChoose")} onPress={() => void create()} busy={busy} disabled={!trimmed} />
          </View>
        }
      >
        <SheetHeader title={t("roles.new")} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          <Text tone="body">{t("roles.createSub")}</Text>
          <TextField
            label={t("files.name")}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setError(undefined);
            }}
            maxLength={NAME_MAX}
            showCount
            placeholder={t("roles.namePlaceholder")}
            autoFocus
            error={error}
          />
          <RoleColours colour={colour} onColour={setColour} />
          {copyable.length > 0 ? (
            <View>
              <Text variant="smallStrong">{t("roles.copyFrom")}</Text>
              <ActionRow
                title={t("roles.fromNothing")}
                selected={copyFrom === null}
                onPress={() => pickSource(null)}
                trailing={copyFrom === null ? <Check size={20} color={c.ink} /> : undefined}
              />
              {copyable.map((role) => (
                <ActionRow
                  key={role.id}
                  leading={<RoleDot colour={roleColourKey(role)} size={20} />}
                  title={role.name}
                  selected={copyFrom === role.id}
                  onPress={() => pickSource(role.id)}
                  trailing={copyFrom === role.id ? <Check size={20} color={c.ink} /> : undefined}
                />
              ))}
            </View>
          ) : null}
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
