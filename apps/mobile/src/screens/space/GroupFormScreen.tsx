/**
 * The name and description of a group, in a sheet: a new group (which then opens its editor, to add
 * its people) or, with a `groupId`, the name of an existing one. The name is also what is mentioned.
 * Limits and refusals are the web's (60 and 280 characters, a name taken, reserved or invalid).
 */
import { refusalOf, type Group } from "@ruchoir/client";
import { GROUP_DESCRIPTION_MAX } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

const NAME_MAX = 60;

export function GroupFormScreen() {
  const { listGroups } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "groupCreate">>();
  const { current } = useSpace();
  const groupId = params?.groupId;
  const groups = useLoad(current && groupId ? `groups:${current.id}` : null, () => listGroups(current!.id));
  if (!current) return null;
  if (groupId) {
    const group = groups.data?.find((g) => g.id === groupId);
    // The group is read first: the fields start from what is saved.
    return group ? <Form spaceId={current.id} group={group} /> : <View style={styles.fill} />;
  }
  return <Form spaceId={current.id} />;
}

function Form({ spaceId, group }: { spaceId: string; group?: Group }) {
  const { createGroup, updateGroup } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const trimmed = name.trim();
  const unchanged = !!group && trimmed === group.name && description.trim() === (group.description ?? "");

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (group) {
        await updateGroup(spaceId, group.id, { name: trimmed, description: description.trim() });
        feel("success");
        toast(t("groups.saved"), "success");
        navigation.goBack();
      } else {
        const created = await createGroup(spaceId, { name: trimmed, description: description.trim() || undefined });
        feel("success");
        toast(t("groups.created"), "success");
        // The editor replaces this sheet: leaving it goes back to the list.
        navigation.goBack();
        navigation.navigate("groupEditor", { groupId: created.id });
      }
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      const text = said ? String(t(said.key as never, said.vars as never)) : t("roles.saveFailed");
      // A refused name is said under the field; anything else is a toast.
      if (said && /^groups\.refusal\.name/.test(said.key)) setError(text);
      else toast(text, "failure");
      setBusy(false);
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <KeyboardForm
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            <Button label={group ? t("compose.save") : t("groups.createAndAdd")} onPress={() => void save()} busy={busy} disabled={!trimmed || unchanged} />
          </View>
        }
      >
        <SheetHeader title={group ? t("groups.editTitle") : t("groups.create")} onClose={() => navigation.goBack()} />
        <View style={styles.pad}>
          {group ? null : <Text tone="body">{t("groups.createSub")}</Text>}
          <TextField
            label={t("files.name")}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setError(undefined);
            }}
            maxLength={NAME_MAX}
            autoFocus
            error={error}
            hint={trimmed ? t("groups.nameHint", { name: trimmed }) : undefined}
          />
          <TextField label={t("groups.descOptional")} value={description} onChangeText={setDescription} maxLength={GROUP_DESCRIPTION_MAX} />
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
