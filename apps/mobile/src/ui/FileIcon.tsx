import { FAMILY_COLOR, fileFamily, type FileFamily } from "@ruchoir/client";
import {
  BookOpen,
  Box,
  CalendarDays,
  Captions,
  CodeXml,
  Database,
  File,
  FileArchive,
  FileText,
  Film,
  Folder,
  Image,
  KeyRound,
  Mail,
  Map as MapGlyph,
  Music,
  Package,
  Palette,
  PenTool,
  Presentation,
  ScrollText,
  Settings2,
  Sheet,
  TextAlignStart,
  Type,
  type LucideIcon,
} from "lucide-react-native";
import { View } from "react-native";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

import { fonts } from "../theme/fonts";
import { mix } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";

/** The design system's glyph for each family (`FileIcon` of the Ruchoir design system). */
const GLYPH: Record<FileFamily, LucideIcon> = {
  pdf: FileText,
  document: TextAlignStart,
  spreadsheet: Sheet,
  presentation: Presentation,
  image: Image,
  vector: PenTool,
  video: Film,
  audio: Music,
  archive: FileArchive,
  code: CodeXml,
  config: Settings2,
  text: ScrollText,
  data: Database,
  design: Palette,
  font: Type,
  ebook: BookOpen,
  model: Box,
  application: Package,
  mail: Mail,
  calendar: CalendarDays,
  security: KeyRound,
  map: MapGlyph,
  subtitles: Captions,
  other: File,
};

const PAGE = "M7 1.5h14.5L31 11v25.5a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5v-30a5 5 0 0 1 5-5z";
const FOLD = "M21.5 1.5V7a4 4 0 0 0 4 4H31";

const extension = (name: string) => {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
};

/**
 * A file's kind at a glance, drawn as the design system draws it (and the phone and tablet mockups):
 * a page with its corner folded, tinted with the family's colour (red for a PDF, green for a
 * spreadsheet), the family's glyph, and the extension on a chip from 28 points up. `size` is the
 * page's height; it is a third narrower. A folder is the folder's own glyph.
 */
export function FileIcon({ name, mime, folder, size = 40 }: { name: string; mime?: string; folder?: boolean; size?: number }) {
  const { c, dark } = useTheme();
  if (folder) {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Folder size={Math.round(size * 0.55)} color={c.ink} />
      </View>
    );
  }
  const family = fileFamily(name, mime);
  const color = FAMILY_COLOR[family];
  const Glyph = GLYPH[family] ?? File;
  const ext = extension(name).slice(0, 4).toUpperCase();
  const withChip = size >= 28 && ext.length > 0;
  const width = Math.round((size * 33) / 43);
  const small = size < 40;
  const chipFont = small ? 8.4 : 6.6;
  const chipHeight = small ? 12.5 : 10;
  const chipWidth = (small ? 7 : 6) + ext.length * (small ? 4.9 : 3.9);
  const chipTop = small ? 25 : 26;
  const glyphSize = Math.round(size * (withChip ? 0.36 : 0.42));
  // `.wc-fi`: the page a light tint of the colour (a little more by night), its outline and fold a
  // third of it, the glyph the colour itself (lightened by night).
  const page = mix(color, c.surface, dark ? 0.16 : 0.11);
  const line = mix(color, c.surface, 0.34);
  const fold = mix(color, c.surface, 0.18);
  const ink = dark ? mix(color, "#ffffff", 0.68) : color;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width, height: size }}>
      <Svg width={width} height={size} viewBox="0 0 33 43" style={{ overflow: "visible" }}>
        <Path d={PAGE} fill={page} stroke={line} strokeWidth={1.2} />
        <Path d={FOLD} fill={fold} stroke={line} strokeWidth={1.2} strokeLinejoin="round" />
        {withChip ? (
          <>
            <Rect x={-1} y={chipTop} width={chipWidth} height={chipHeight} rx={3} fill={color} />
            <SvgText
              x={-1 + chipWidth / 2}
              y={chipTop + chipHeight / 2 + chipFont * 0.36}
              textAnchor="middle"
              fontSize={chipFont}
              fontWeight="700"
              fontFamily={fonts.sansBold}
              fill="#ffffff"
            >
              {ext}
            </SvgText>
          </>
        ) : null}
      </Svg>
      <View style={{ position: "absolute", left: (width - glyphSize) / 2, top: Math.round(size * (withChip ? (small ? 0.22 : 0.26) : 0.36)) }}>
        <Glyph size={glyphSize} strokeWidth={2} color={ink} />
      </View>
    </View>
  );
}
