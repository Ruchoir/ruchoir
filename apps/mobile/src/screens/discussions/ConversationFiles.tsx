import { FileText } from "lucide-react-native";
import { FlatList } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { EmptyState, LoadState } from "../../ui/States";
import { FileRow } from "../files/FileRow";

/** The files shared in a conversation (the Files tab of mockup 13). */
export function ConversationFiles({ conversationId }: { conversationId: string }) {
  const { getConversationFiles } = useApi();
  const { t } = useTranslation();
  const files = useLoad(`conversationFiles:${conversationId}`, (signal) => getConversationFiles(conversationId, signal));
  useReloadOn((e) => e.type === "files", files.reload);
  if (!files.data) return <LoadState error={files.error} onRetry={files.reload} />;
  return (
    <FlatList
      data={files.data}
      keyExtractor={(f, i) => f.id ?? String(i)}
      contentContainerStyle={{ flexGrow: 1 }}
      renderItem={({ item }) => <FileRow file={item} />}
      ListEmptyComponent={<EmptyState icon={FileText} title={t("conversation.noFiles")} text={t("conversation.noFilesHint")} />}
    />
  );
}
