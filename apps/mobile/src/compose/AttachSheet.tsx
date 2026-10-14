/**
 * "Add to the message" (mockup 14): a photo or a video from the gallery, a photo taken now, a
 * document from the phone, or a file already in the space. The phone's pickers open over this sheet;
 * what is picked goes to the composer, which starts sending it at once.
 *
 * "Propose a meeting" waits for the agenda's writing step.
 */
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Camera, Folder, Image as ImageIcon, Paperclip } from "lucide-react-native";
import { StyleSheet } from "react-native";

import { useTranslation } from "../i18n";
import type { RootParams } from "../navigation/types";
import { useSpace } from "../space/SpaceProvider";
import { useTheme } from "../theme/useTheme";
import { ActionRow } from "../ui/ActionRow";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { pickDocuments, pickFromCamera, pickFromGallery } from "./pick";
import { requestAttach } from "./requests";
import type { LocalFile } from "./useAttachments";

export function AttachSheet() {
  const { params } = useRoute<RouteProp<RootParams, "attachSheet">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current, spaces } = useSpace();
  // The space whose files are offered: the one asked for (an event's), else the current one.
  const space = params.spaceId ? spaces.data?.find((w) => w.id === params.spaceId) : current;

  // A cancelled picker leaves the sheet open, to pick another way.
  const hand = (files: LocalFile[]) => {
    if (files.length === 0) return;
    requestAttach({ draftKey: params.draftKey, kind: "local", files });
    navigation.goBack();
  };

  const fromGallery = async () => hand(await pickFromGallery());
  const fromCamera = async () => hand(await pickFromCamera(t));
  const fromFiles = async () => hand(await pickDocuments());

  return (
    <Sheet>
      <Text variant="heading" style={styles.title}>
        {params.title ?? t("compose.add")}
      </Text>
      <ActionRow icon={ImageIcon} tint={c.sky} title={t("attach.gallery")} subtitle={t("attach.galleryHint")} onPress={() => void fromGallery()} />
      <ActionRow icon={Camera} tint={c.peach} title={t("attach.camera")} subtitle={t("attach.cameraHint")} onPress={() => void fromCamera()} />
      <ActionRow icon={Paperclip} tint={c.violet} title={t("attach.document")} subtitle={t("attach.documentHint")} onPress={() => void fromFiles()} />
      {space ? (
        <ActionRow
          icon={Folder}
          tint={c.mint}
          title={t("attach.space")}
          subtitle={space.name}
          onPress={() => navigation.replace("spaceFilePicker", { draftKey: params.draftKey, spaceId: space.id })}
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
});
