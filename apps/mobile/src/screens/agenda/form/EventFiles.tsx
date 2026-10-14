import { Paperclip, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { useTranslation } from "../../../i18n";
import type { EventDraft } from "../../../logic/eventForm";
import { useTheme } from "../../../theme/useTheme";
import { FileCard } from "../../../ui/FileCard";
import { Text } from "../../../ui/Text";
import { updateDraft } from "./draftStore";
import { MAX_EVENT_FILES, type PendingUpload } from "./useEventUploads";

/**
 * The files an event carries (mockup 19): a card each with its cross, the phone's files still going
 * with how far they are (a failed one retried with a tap), and "Add a file".
 */
export function EventFiles({
  formKey,
  draft,
  pending,
  onAdd,
  onRetry,
  onRemove,
}: {
  formKey: string;
  draft: EventDraft;
  pending: PendingUpload[];
  onAdd: () => void;
  onRetry: (item: PendingUpload) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const cross = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("attach.remove", { name: label })}
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [styles.cross, { backgroundColor: s.sunken }, pressed && { opacity: 0.6 }]}
    >
      <X size={14} color={c.ink} />
    </Pressable>
  );
  const full = draft.files.length + pending.length >= MAX_EVENT_FILES;
  return (
    <View style={styles.list}>
      {draft.files.map((f) => (
        <FileCard
          key={f.id}
          name={f.name}
          sizeBytes={f.size}
          trailing={cross(f.name, () => updateDraft(formKey, (d) => ({ ...d, files: d.files.filter((x) => x.id !== f.id), filesTouched: true })))}
        />
      ))}
      {pending.map((item) => (
        <FileCard
          key={item.key}
          name={item.file.name}
          sizeBytes={item.file.size}
          onPress={item.failed ? () => onRetry(item) : undefined}
          trailing={
            <View style={styles.pending}>
              <Text variant="tiny" tone={item.failed ? "danger" : "muted"}>
                {item.failed
                  ? t("attach.failed")
                  : t("attach.uploading", { percent: item.file.size ? Math.min(99, Math.round((item.sent / item.file.size) * 100)) : 0 })}
              </Text>
              {cross(item.file.name, () => onRemove(item.key))}
            </View>
          }
        />
      ))}
      {full ? (
        <Text variant="tiny" tone="muted">
          {t("eventForm.filesMax")}
        </Text>
      ) : (
        <Pressable accessibilityRole="button" onPress={onAdd} style={({ pressed }) => [styles.add, pressed && { opacity: 0.6 }]}>
          <Paperclip size={16} color={c.muted} />
          <Text variant="body" tone="muted">
            {t("eventForm.addFile")}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  cross: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  pending: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 170 },
  add: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
});
