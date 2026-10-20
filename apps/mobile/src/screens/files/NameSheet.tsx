import { isTaken } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

/**
 * A new folder's name, an entry's new name, or a new blank document's (opened in the editor once
 * made): empty or taken in the folder is said under the field.
 */
export function NameSheet() {
  const { createBlankDocument, createFolder, getFolder, updateFile } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "fileName">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const [name, setName] = useState(params.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folder = useLoad(`names:${params.spaceId}:${params.folderId ?? "root"}`, (signal) => getFolder(params.spaceId, params.folderId, signal));
  const rename = params.mode === "rename";
  const document = params.mode === "document";

  const save = async () => {
    const wanted = name.trim();
    if (!wanted) return setError(t("files.nameEmpty"));
    if (rename && wanted === params.name) return navigation.goBack();
    const others = (folder.data?.entries ?? []).filter((e) => e.id !== params.fileId).map((e) => e.name);
    if (isTaken(wanted, others)) return setError(t("files.nameUsed"));
    setBusy(true);
    if (document) {
      try {
        const made = await createBlankDocument(params.spaceId, params.kind ?? "document", wanted, params.folderId);
        navigation.replace("officeEditor", { fileId: made.id!, name: made.name });
      } catch {
        setBusy(false);
        setError(t("office.createFailed"));
      }
      return;
    }
    try {
      if (rename) await updateFile(params.fileId!, { name: wanted });
      else await createFolder(params.spaceId, wanted, params.folderId);
      navigation.goBack();
      toast(rename ? t("files.renamed") : t("files.folderCreated"));
    } catch {
      setBusy(false);
      setError(rename ? t("files.renameFailed") : t("files.folderFailed"));
    }
  };

  return (
    <KeyboardForm
      contentContainerStyle={styles.form}
      footer={
        <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
          <Button label={rename ? t("files.rename") : t("files.create")} busy={busy} onPress={() => void save()} />
        </View>
      }
    >
      <Text variant="heading">
        {rename
          ? t("files.rename")
          : !document
            ? t("files.newFolder")
            : params.kind === "spreadsheet"
              ? t("office.kindSpreadsheet")
              : params.kind === "presentation"
                ? t("office.kindPresentation")
                : t("office.kindDocument")}
      </Text>
      <TextField
        label={rename || document ? t("files.name") : t("files.folderName")}
        value={name}
        onChangeText={(next) => {
          setName(next);
          setError(null);
        }}
        autoFocus
        selectTextOnFocus={rename}
        autoCapitalize="sentences"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        maxLength={255}
        error={error ?? undefined}
      />
    </KeyboardForm>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 16 },
  foot: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
