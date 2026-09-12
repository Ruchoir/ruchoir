import {
  Archive,
  ArrowLeft,
  AtSign,
  Bell,
  BellOff,
  Bold,
  Bookmark,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Fingerprint,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  HardDrive,
  Hash,
  Heart,
  Image as ImageIcon,
  Import,
  Inbox,
  Info,
  Italic,
  Languages,
  Keyboard,
  KeyRound,
  LayoutGrid,
  LifeBuoy,
  List,
  Lock,
  LogOut,
  type LucideIcon,
  Mail,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Paperclip,
  PartyPopper,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Smile,
  SmilePlus,
  SquarePen,
  Star,
  StarOff,
  ThumbsUp,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";

/**
 * Icon set used across the app, keyed by the kebab-case Lucide names the design-system
 * mockups reference. Sovereignty rule: icons are the `lucide-react` package (ISC,
 * community-governed), rendered as inline SVG. No runtime CDN, CSP-safe. Extend this map
 * when a screen needs a new glyph rather than reaching for a network URL.
 */
const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  "arrow-left": ArrowLeft,
  "at-sign": AtSign,
  bell: Bell,
  "bell-off": BellOff,
  bold: Bold,
  bookmark: Bookmark,
  check: Check,
  "check-check": CheckCheck,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  clock: Clock,
  code: Code,
  copy: Copy,
  download: Download,
  "external-link": ExternalLink,
  eye: Eye,
  file: File,
  "file-archive": FileArchive,
  "file-spreadsheet": FileSpreadsheet,
  "file-text": FileText,
  fingerprint: Fingerprint,
  folder: Folder,
  "folder-open": FolderOpen,
  "folder-plus": FolderPlus,
  globe: Globe,
  "hard-drive": HardDrive,
  hash: Hash,
  heart: Heart,
  image: ImageIcon,
  import: Import,
  inbox: Inbox,
  info: Info,
  italic: Italic,
  languages: Languages,
  keyboard: Keyboard,
  "key-round": KeyRound,
  "layout-grid": LayoutGrid,
  "life-buoy": LifeBuoy,
  list: List,
  lock: Lock,
  "log-out": LogOut,
  mail: Mail,
  "message-square": MessageSquare,
  minus: Minus,
  "more-horizontal": MoreHorizontal,
  paperclip: Paperclip,
  "party-popper": PartyPopper,
  pin: Pin,
  play: Play,
  plus: Plus,
  "refresh-cw": RefreshCw,
  search: Search,
  send: Send,
  server: Server,
  settings: Settings,
  shield: Shield,
  "shield-check": ShieldCheck,
  smile: Smile,
  "smile-plus": SmilePlus,
  "square-pen": SquarePen,
  star: Star,
  "star-off": StarOff,
  "thumbs-up": ThumbsUp,
  "trash-2": Trash2,
  upload: Upload,
  "user-plus": UserPlus,
  users: Users,
  x: X,
};

export type IconName = keyof typeof ICONS;

export type IconProps = {
  name: string;
  size?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/** Lucide glyph, coloured by currentColor. `title` makes it an accessible image. */
export function Icon({ name, size = 16, title, className, style }: IconProps) {
  const Glyph = ICONS[name];
  if (!Glyph) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`Icon "${name}" is not registered in components/ds/Icon.tsx`);
    }
    return null;
  }
  return (
    <Glyph
      size={size}
      className={className}
      style={style}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
