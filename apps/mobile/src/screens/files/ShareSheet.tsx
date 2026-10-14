import { fileDownloadUrl, getInstanceCapabilities } from "@ruchoir/client";
import { canManage } from "@ruchoir/client/filesLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Sharing from "expo-sharing";
import { Link, MessageSquare, Share as ShareIcon } from "lucide-react-native";

import { useLoad } from "../../data/useLoad";
import { downloadToCache } from "../../files/download";
import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/**
 * Sharing a file (the web's share dialog): into a conversation, the way to show it to someone in
 * Ruchoir; to another app of the phone; and, for who manages it, public links for people outside.
 */
export function ShareSheet() {
  const { params } = useRoute<RouteProp<RootParams, "fileShare">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const { current } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const file = params.file;
  const caps = useLoad("capabilities", (signal) => getInstanceCapabilities(signal));
  const manage = canManage(file, me, current?.role);
  return (
    <Sheet>
      <Text variant="heading">{t("files.shareTitle", { name: file.name })}</Text>
      <ActionRow icon={MessageSquare} tint={c.pink} title={t("files.sendToConversation")} onPress={() => navigation.replace("fileSendTo", { file, spaceId: params.spaceId })} />
      <ActionRow
        icon={ShareIcon}
        tint={c.violet}
        title={t("viewer.share")}
        onPress={() => {
          navigation.goBack();
          void downloadToCache({ id: file.id!, name: file.name, url: fileDownloadUrl(file.id!), mime: file.mimeType, sizeBytes: file.sizeBytes })
            .then((uri) => Sharing.shareAsync(uri, { mimeType: file.mimeType, dialogTitle: file.name }))
            .catch(() => toast(t("files.actionFailed")));
        }}
      />
      {manage && caps.data?.publicLinks ? (
        <ActionRow
          icon={Link}
          tint={c.sky}
          title={t("files.publicLinks")}
          subtitle={t("files.publicLinksHint")}
          onPress={() => navigation.replace("fileLinks", { file })}
        />
      ) : null}
    </Sheet>
  );
}
