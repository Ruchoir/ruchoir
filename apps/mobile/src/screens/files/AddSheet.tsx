import { canManage } from "@ruchoir/client/filesLogic";
import { getFolder } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Camera, FileText, FolderPlus, Image as ImageIcon, Paperclip } from "lucide-react-native";
import { Alert } from "react-native";

import { uploadLimit } from "../../api/limits";
import { pickDocuments, pickFromCamera, pickFromGallery } from "../../compose/pick";
import type { LocalFile } from "../../compose/useAttachments";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { splitBySize } from "../../logic/attachments";
import { fileSize } from "../../logic/format";
import type { RootParams } from "../../navigation/types";
import { useSession } from "../../session/SessionProvider";
import { useSpace } from "../../space/SpaceProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useUploads } from "../../uploads/UploadsProvider";

/**
 * "Add a file" (mockup 21): a photo or a video, a photo taken now, a document of the phone, a scanned
 * document, a new folder, into the folder the person is in. What is picked goes to the uploads;
 * a name already taken there asks first.
 */
export function AddSheet() {
  const { params } = useRoute<RouteProp<RootParams, "filesAdd">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const { current } = useSpace();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const uploads = useUploads();
  // The folder's entries, for the names already taken there.
  const folder = useLoad(`add:${params.spaceId}:${params.folderId ?? "root"}`, (signal) => getFolder(params.spaceId, params.folderId, signal));
  const target = { spaceId: params.spaceId, folderId: params.folderId };

  const hand = async (picked: LocalFile[]) => {
    if (picked.length === 0) return;
    const limit = await uploadLimit();
    const { accepted, refused } = splitBySize(picked, limit);
    if (limit !== undefined && refused.length > 0) {
      Alert.alert(
        t("attach.tooLargeTitle", { count: refused.length }),
        t("attach.tooLargeText", { names: refused.map((f) => f.name).join(", "), limit: fileSize(limit, locale) }),
      );
    }
    if (accepted.length === 0) return;
    const entries = folder.data?.entries ?? (await getFolder(params.spaceId, params.folderId).then((f) => f.entries, () => []));
    const existing = entries.flatMap((e) => (e.id ? [{ id: e.id, name: e.name, manage: canManage(e, me, current?.role) }] : []));
    const asks = uploads.add(accepted, target, existing, params.folderName);
    if (asks) navigation.replace("uploadConflict");
    else navigation.goBack();
  };

  return (
    <Sheet>
      <Text variant="heading">{t("eventForm.addFile")}</Text>
      <ActionRow icon={ImageIcon} tint={c.sky} title={t("attach.gallery")} subtitle={t("attach.galleryHint")} onPress={() => void pickFromGallery().then(hand)} />
      <ActionRow icon={Camera} tint={c.peach} title={t("attach.camera")} subtitle={t("attach.cameraHint")} onPress={() => void pickFromCamera(t).then(hand)} />
      <ActionRow icon={Paperclip} tint={c.violet} title={t("attach.document")} subtitle={t("attach.documentHint")} onPress={() => void pickDocuments().then(hand)} />
      <ActionRow
        icon={FileText}
        tint={c.mint}
        title={t("files.scanTitle")}
        subtitle={t("files.scanHint")}
        onPress={() => navigation.replace("scan", { spaceId: params.spaceId, folderId: params.folderId, folderName: params.folderName })}
      />
      <ActionRow
        icon={FolderPlus}
        tint={c.sun}
        title={t("files.newFolder")}
        subtitle={t("files.newFolderHint")}
        onPress={() => navigation.replace("fileName", { mode: "create", spaceId: params.spaceId, folderId: params.folderId })}
      />
    </Sheet>
  );
}
