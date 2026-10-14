import { Calendar, Folder, House, MessageSquare, type LucideIcon } from "lucide-react-native";

import { key } from "../../i18n";
import type { Palette } from "../../theme/tokens";

/** The tutorial's four pages (mockups 02 and 03, the prototype's texts): one per tab. */
export const TUTORIAL: { icon: LucideIcon; color: keyof Palette; chip: ReturnType<typeof key>; title: ReturnType<typeof key>; text: ReturnType<typeof key> }[] = [
  { icon: House, color: "sky", chip: key("time.today"), title: key("tutorial.todayTitle"), text: key("tutorial.todayText") },
  {
    icon: MessageSquare,
    color: "mint",
    chip: key("tabs.discussions"),
    title: key("tutorial.discussionsTitle"),
    text: key("tutorial.discussionsText"),
  },
  { icon: Calendar, color: "violet", chip: key("tabs.agenda"), title: key("tutorial.agendaTitle"), text: key("tutorial.agendaText") },
  { icon: Folder, color: "peach", chip: key("tabs.files"), title: key("tutorial.filesTitle"), text: key("tutorial.filesText") },
];
