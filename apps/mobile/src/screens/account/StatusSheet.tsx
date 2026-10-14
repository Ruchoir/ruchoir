import { setMyPresence, type PresenceChoice } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Check, CircleCheck, CircleMinus, Clock, EyeOff, type LucideIcon } from "lucide-react-native";

import { key, useTranslation } from "../../i18n";
import { useSession } from "../../session/SessionProvider";
import type { Palette } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** How each status is told and drawn, as the web's menu names them. */
export const STATUS_TEXT: Record<PresenceChoice, { title: ReturnType<typeof key>; text: ReturnType<typeof key> }> = {
  auto: { title: key("status.auto"), text: key("status.autoText") },
  away: { title: key("presence.away"), text: key("status.awayText") },
  busy: { title: key("status.busy"), text: key("status.busyText") },
  invisible: { title: key("status.invisible"), text: key("status.invisibleText") },
};

const STATUS_LOOK: Record<PresenceChoice, { icon: LucideIcon; tint: keyof Palette }> = {
  auto: { icon: CircleCheck, tint: "mint" },
  away: { icon: Clock, tint: "sun" },
  busy: { icon: CircleMinus, tint: "peach" },
  invisible: { icon: EyeOff, tint: "sky" },
};

const CHOICES: PresenceChoice[] = ["auto", "away", "busy", "invisible"];

/** The status the others see: chosen here, shown at once, put back if the server refuses it. */
export function StatusSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation();
  if (session.state.kind !== "signedIn") return null;
  const current = session.state.user.presenceChoice;

  const pick = (choice: PresenceChoice) => {
    navigation.goBack();
    if (choice === current) return;
    session.updateUser({ presenceChoice: choice });
    setMyPresence(choice).catch(() => {
      session.updateUser({ presenceChoice: current });
      toast(t("status.failed"));
    });
  };

  return (
    <Sheet>
      <Text variant="heading">{t("account.status")}</Text>
      {CHOICES.map((choice) => (
        <ActionRow
          key={choice}
          icon={STATUS_LOOK[choice].icon}
          tint={c[STATUS_LOOK[choice].tint]}
          title={t(STATUS_TEXT[choice].title)}
          subtitle={t(STATUS_TEXT[choice].text)}
          selected={choice === current}
          trailing={choice === current ? <Check size={20} color={c.ink} /> : undefined}
          onPress={() => pick(choice)}
        />
      ))}
    </Sheet>
  );
}
