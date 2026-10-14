/**
 * "Add to the message" (mockup 14): a photo or a video from the gallery, a photo taken now, a
 * document from the phone, or a file already in the space. The phone's pickers open over this sheet;
 * what is picked goes to the composer, which starts sending it at once.
 *
 * "Propose a meeting" waits for the agenda's writing step.
 */
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Camera, Folder, Image as ImageIcon, Paperclip } from "lucide-react-native";
import { Alert, Linking, StyleSheet } from "react-native";

import { useTranslation } from "../i18n";
import type { RootParams } from "../navigation/types";
import { useSpace } from "../space/SpaceProvider";
import { useTheme } from "../theme/useTheme";
import { ActionRow } from "../ui/ActionRow";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { requestAttach } from "./requests";
import type { LocalFile } from "./useAttachments";

/** A picked photo or video as a file to send. The camera's have no name: they get one from the hour. */
function fromAsset(asset: ImagePicker.ImagePickerAsset): LocalFile {
  const video = asset.type === "video";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  return {
    uri: asset.uri,
    name: asset.fileName ?? `${video ? "VID" : "IMG"}_${stamp}.${video ? "mp4" : "jpg"}`,
    mime: asset.mimeType ?? (video ? "video/mp4" : "image/jpeg"),
    size: asset.fileSize,
    width: asset.width,
    height: asset.height,
  };
}

export function AttachSheet() {
  const { params } = useRoute<RouteProp<RootParams, "attachSheet">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const { current } = useSpace();

  const hand = (files: LocalFile[]) => {
    if (files.length > 0) requestAttach({ draftKey: params.draftKey, kind: "local", files });
    navigation.goBack();
  };

  const fromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: 10,
      quality: 0.85,
      // A JPEG rather than the iPhone's HEIC, which a browser on the other end cannot show.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) hand(result.assets.map(fromAsset));
  };

  const fromCamera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(t("attach.cameraDenied"), t("attach.cameraDeniedText"), [
        { text: t("compose.cancel"), style: "cancel" },
        { text: t("attach.openSettings"), onPress: () => void Linking.openSettings() },
      ]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (!result.canceled) hand(result.assets.map(fromAsset));
  };

  const fromFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (!result.canceled) {
      hand(result.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? "application/octet-stream", size: a.size })));
    }
  };

  return (
    <Sheet>
      <Text variant="heading" style={styles.title}>
        {t("compose.add")}
      </Text>
      <ActionRow icon={ImageIcon} tint={c.sky} title={t("attach.gallery")} subtitle={t("attach.galleryHint")} onPress={() => void fromGallery()} />
      <ActionRow icon={Camera} tint={c.peach} title={t("attach.camera")} subtitle={t("attach.cameraHint")} onPress={() => void fromCamera()} />
      <ActionRow icon={Paperclip} tint={c.violet} title={t("attach.document")} subtitle={t("attach.documentHint")} onPress={() => void fromFiles()} />
      {current ? (
        <ActionRow
          icon={Folder}
          tint={c.mint}
          title={t("attach.space")}
          subtitle={current.name}
          onPress={() => navigation.replace("spaceFilePicker", { draftKey: params.draftKey })}
        />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
});
