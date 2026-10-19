import { useNavigation } from "@react-navigation/native";
import { Copy, FilePen, SkipForward } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "../../i18n";
import { choicesFor, nextQuestion, type Choice } from "../../logic/uploadQueue";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useUploads } from "../../uploads/UploadsProvider";
import { Toggle } from "../../ui/Toggle";

/**
 * A duplicate the server refused (it checks the whole space): the same file already in the folder
 * offers to replace it (a new version of it) or skip; the same name with other contents offers to
 * keep both under a numbered name ("Devis (1).pdf") or skip; the same for the others when several
 * collide alike. It asks again for the next one, goes once nothing asks, and closing it skips what
 * still asks.
 */
export function ConflictSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation();
  const uploads = useUploads();
  const question = nextQuestion(uploads.queue);
  const [forAll, setForAll] = useState(false);
  useEffect(() => {
    if (!question) navigation.goBack();
  }, [question, navigation]);
  // Swiped away: what still asks is skipped, or the sheet would come straight back.
  const latest = useRef(uploads);
  useEffect(() => {
    latest.current = uploads;
  });
  useEffect(
    () => () => {
      for (const item of latest.current.queue) if (item.state === "asking") latest.current.answer(item.key, "skip", true);
    },
    [],
  );
  if (!question?.duplicate) return null;
  const { reason, existing, path } = question.duplicate;
  const offered = choicesFor(reason);
  const others = uploads.queue.filter((i) => i.state === "asking" && i.key !== question.key && i.duplicate?.reason === reason).length;
  const choose = (choice: Choice) => uploads.answer(question.key, choice, forAll);
  const folder = path.length ? path.join(" / ") : uploads.label(question);
  return (
    <Sheet>
      <Text variant="heading">
        {reason === "same_file" ? t("files.sameFileTitle", { name: existing.name }) : t("files.conflictTitle", { name: question.name })}
      </Text>
      <Text variant="small" tone="muted" style={styles.body}>
        {reason === "same_file" ? t("files.sameFileBody", { folder }) : t("files.sameNameBody", { folder })}
      </Text>
      {offered.includes("replace") ? (
        <ActionRow icon={FilePen} tint={c.violet} title={t("files.conflictReplace")} subtitle={t("files.conflictReplaceHint")} onPress={() => choose("replace")} />
      ) : null}
      {offered.includes("keepBoth") ? (
        <ActionRow icon={Copy} tint={c.mint} title={t("files.rename")} subtitle={t("files.conflictRenameHint")} onPress={() => choose("keepBoth")} />
      ) : null}
      <ActionRow icon={SkipForward} title={t("files.conflictSkip")} onPress={() => choose("skip")} />
      {others > 0 ? (
        <View style={styles.forAll}>
          <Text variant="body" style={styles.grow}>
            {t("files.conflictForAll", { count: others })}
          </Text>
          <Toggle value={forAll} onValueChange={setForAll} accessibilityLabel={t("files.conflictForAll", { count: others })} />
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
