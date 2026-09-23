import type { CSSProperties } from "react";
import {
  AlignLeft,
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
  Image,
  KeyRound,
  type LucideIcon,
  Mail,
  Map,
  Music,
  Package,
  Palette,
  PenTool,
  Presentation,
  ScrollText,
  Settings2,
  Sheet,
  Type,
} from "lucide-react";
import { FAMILY_COLOR, type FileFamily, fileExtension, fileFamily } from "@/lib/fileType";

const GLYPH: Record<FileFamily, LucideIcon> = {
  pdf: FileText,
  document: AlignLeft,
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
  map: Map,
  subtitles: Captions,
  other: File,
};

export type FileIconProps = {
  /** The file's name: its extension decides the family, and is written on the icon when it is large. */
  name: string;
  /** The MIME type, for a name that has no extension to go by. */
  mime?: string;
  /** Height in pixels; the page is narrower than it is tall. */
  size?: number;
  style?: CSSProperties;
};

/** The page, with its top-right corner folded, drawn in a 33 by 43 box. */
const PAGE = "M7 1.5h14.5L31 11v25.5a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5v-30a5 5 0 0 1 5-5z";
const FOLD = "M21.5 1.5V7a4 4 0 0 0 4 4H31";

/**
 * A file, as a page tinted with its format's colour, the format's glyph on it, and from 28 px up a
 * chip naming the extension.
 *
 * Quiet on purpose: a conversation is read for what people wrote, and the attachments under it are
 * recognised by their colour and shape rather than announced. Decorative for assistive technology,
 * because the file's name is always written next to it.
 */
export function FileIcon({ name, mime, size = 20, style }: FileIconProps) {
  const family = fileFamily(name, mime);
  const Glyph = GLYPH[family];
  const ext = fileExtension(name).slice(0, 4).toUpperCase();
  const withChip = size >= 28 && ext.length > 0;
  const width = Math.round((size * 33) / 43);
  // Below 40 px the chip is drawn larger inside the page, or its letters are too small to read.
  const small = size < 40;
  const chipFont = small ? 8.4 : 6.6;
  const chipHeight = small ? 12.5 : 10;
  const chipWidth = (small ? 7 : 6) + ext.length * (small ? 4.9 : 3.9);
  const chipTop = small ? 25 : 26;
  const glyphSize = Math.round(size * (withChip ? 0.36 : 0.42));
  return (
    <span
      className="wc-fi"
      aria-hidden
      style={{
        position: "relative",
        display: "inline-block",
        flex: "none",
        width,
        height: size,
        ["--fi-c" as string]: FAMILY_COLOR[family],
        ...style,
      }}
    >
      <svg width={width} height={size} viewBox="0 0 33 43" style={{ display: "block", overflow: "visible" }}>
        <path d={PAGE} className="wc-fi__page" strokeWidth={1.2} />
        <path d={FOLD} className="wc-fi__fold" strokeWidth={1.2} strokeLinejoin="round" />
        {withChip ? (
          <>
            <rect x={-1} y={chipTop} width={chipWidth} height={chipHeight} rx={3} className="wc-fi__chip" />
            <text
              x={-1 + chipWidth / 2}
              y={chipTop + chipHeight / 2 + chipFont * 0.36}
              textAnchor="middle"
              fontSize={chipFont}
              fontWeight={700}
              fill="#fff"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {ext}
            </text>
          </>
        ) : null}
      </svg>
      <Glyph
        size={glyphSize}
        strokeWidth={2}
        className="wc-fi__glyph"
        style={{
          position: "absolute",
          left: (width - glyphSize) / 2,
          top: Math.round(size * (withChip ? (small ? 0.22 : 0.26) : 0.36)),
        }}
      />
    </span>
  );
}
