import { FAMILY_COLOR, fileFamily, type FileFamily } from "@ruchoir/client";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from "lucide-react-native";
import { StyleSheet, View } from "react-native";

import { mix } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";

const ICON: Partial<Record<FileFamily, LucideIcon>> = {
  pdf: FileText,
  document: FileText,
  text: FileText,
  ebook: FileText,
  spreadsheet: FileSpreadsheet,
  data: FileSpreadsheet,
  presentation: Presentation,
  image: FileImage,
  vector: FileImage,
  design: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  config: FileCode,
};

/**
 * A file's kind at a glance: the family's colour (the web's, red for PDF, green for a spreadsheet)
 * on a tint of itself, or a folder.
 */
export function FileIcon({ name, mime, folder, size = 40 }: { name: string; mime?: string; folder?: boolean; size?: number }) {
  const { c } = useTheme();
  const family = fileFamily(name, mime);
  const color = folder ? c.ink : FAMILY_COLOR[family];
  const Icon = folder ? Folder : (ICON[family] ?? File);
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: folder ? "transparent" : mix(color, c.surface, 0.12) }]}>
      <Icon size={Math.round(size * 0.55)} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
