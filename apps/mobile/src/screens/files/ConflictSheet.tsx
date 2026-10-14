import { isTaken } from "@ruchoir/client/filesLogic";
import { useNavigation } from "@react-navigation/native";
import { Copy, FilePen, SkipForward } from "lucide-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, Switch, View } from "react-native";

import { useTranslation } from "../../i18n";
import { nextQuestion, type Choice } from "../../logic/uploadQueue";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useUploads } from "../../uploads/UploadsProvider";

/**
 * A name already taken in the folder (the web's question): replace (a new version, for who may manage
 * that file), keep both ("Devis (1).pdf") or skip, and the same for the others when several collide.
 * It asks again for the next one, and goes once nothing asks.
 */
export function ConflictSheet() {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const navigation = useNavigation();
  const uploads = useUploads();
  const question = nextQuestion(uploads.queue);
  const [forAll, setForAll] = useState(false);
  useEffect(() => {
    if (!question) navigation.goBack();
  }, [question, navigation]);
  if (!question) return null;
  const others = uploads.queue.filter((i) => i.state === "asking" && i.key !== question.key).length;
  const same = uploads.existing(question).find((e) => isTaken(question.file.name, [e.name]));
  const choose = (choice: Choice) => uploads.answer(question.key, choice, forAll);
  return (
    <Sheet>
      <Text variant="heading">{t("files.conflictTitle", { name: question.file.name })}</Text>
      <Text variant="small" tone="muted" style={styles.body}>
        {t("files.conflictBody", { folder: uploads.label(question) })}
      </Text>
      {same?.manage ? (
        <ActionRow icon={FilePen} tint={c.violet} title={t("files.conflictReplace")} subtitle={t("files.conflictReplaceHint")} onPress={() => choose("replace")} />
      ) : null}
      <ActionRow icon={Copy} tint={c.mint} title={t("files.conflictKeepBoth")} onPress={() => choose("keepBoth")} />
      <ActionRow icon={SkipForward} title={t("files.conflictSkip")} onPress={() => choose("skip")} />
      {others > 0 ? (
        <View style={styles.forAll}>
          <Text variant="body" style={styles.grow}>
            {t("files.conflictForAll", { count: others })}
          </Text>
          <Switch value={forAll} onValueChange={setForAll} trackColor={{ true: c.ink, false: s.sunken }} accessibilityLabel={t("files.conflictForAll", { count: others })} />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { marginBottom: 6 },
  forAll: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 10 },
  grow: { flex: 1 },
});
