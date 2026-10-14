/**
 * The phone's pickers, as the composer and the files tab use them: photos and videos from the
 * gallery, a photo taken now, documents from the phone. Each gives the files picked, or none when the
 * person cancels; the camera, refused, says where to allow it.
 */
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Alert, Linking } from "react-native";

import type { LocalFile } from "./useAttachments";

type Say = (key: "attach.cameraDenied" | "attach.cameraDeniedText" | "compose.cancel" | "attach.openSettings") => string;

/** A picked photo or video as a file to send. The camera's have no name: they get one from the hour. */
export function fromAsset(asset: ImagePicker.ImagePickerAsset): LocalFile {
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

export async function pickFromGallery(): Promise<LocalFile[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    orderedSelection: true,
    selectionLimit: 10,
    quality: 0.85,
    // A JPEG rather than the iPhone's HEIC, which a browser on the other end cannot show.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });
  return result.canceled ? [] : result.assets.map(fromAsset);
}

/** Whether the camera may be used, asking once, and saying where to allow it when refused. */
export async function cameraAllowed(t: Say): Promise<boolean> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (permission.granted) return true;
  Alert.alert(t("attach.cameraDenied"), t("attach.cameraDeniedText"), [
    { text: t("compose.cancel"), style: "cancel" },
    { text: t("attach.openSettings"), onPress: () => void Linking.openSettings() },
  ]);
  return false;
}

export async function pickFromCamera(t: Say): Promise<LocalFile[]> {
  if (!(await cameraAllowed(t))) return [];
  const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return result.canceled ? [] : result.assets.map(fromAsset);
}

export async function pickDocuments(multiple = true): Promise<LocalFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.map((a) => ({ uri: a.uri, name: a.name, mime: a.mimeType ?? "application/octet-stream", size: a.size }));
}
