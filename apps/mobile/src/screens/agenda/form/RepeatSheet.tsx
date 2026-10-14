import { formFor, type Preset } from "@ruchoir/client/calendarLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, Repeat } from "lucide-react-native";

import { useTranslation } from "../../../i18n";
import { useSharedT } from "../../../i18n/sharedT";
import { useLocale } from "../../../i18n/useLocale";
import { draftRule } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Sheet } from "../../../ui/Sheet";
import { Text } from "../../../ui/Text";
import { updateDraft, useDraft } from "./draftStore";
import { repeatChoices, repeatLabel } from "./repeat";

/**
 * How the event repeats: not at all, one of the usual rules (said as the web says them), the rule it
 * came with when the editor cannot show it, or a custom one, set on a screen of its own.
 */
export function RepeatSheet() {
  const { params } = useRoute<RouteProp<RootParams, "eventRepeat">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const say = useSharedT();
  const { c } = useTheme();
  const { locale } = useLocale();
  const draft = useDraft(params.formKey);
  if (!draft) return null;
  const tick = (on: boolean) => (on ? <Check size={20} color={c.ink} /> : undefined);
  const choose = (preset: Preset) => {
    updateDraft(params.formKey, (d) => ({ ...d, preset, ruleTouched: true }));
    navigation.goBack();
  };
  return (
    <Sheet>
      <Text variant="heading">{t("calendar.repeat")}</Text>
      <ActionRow icon={Repeat} tint={c.lime} title={t("calendar.repeatNone")} selected={draft.preset === "none"} trailing={tick(draft.preset === "none")} onPress={() => choose("none")} />
      {repeatChoices(draft.startDay, locale, say).map((choice) => (
        <ActionRow
          key={choice.preset}
          icon={Repeat}
          tint={c.lime}
          title={choice.label}
          selected={draft.preset === choice.preset}
          trailing={tick(draft.preset === choice.preset)}
          onPress={() => choose(choice.preset)}
        />
      ))}
      {draft.preset === "imported" ? (
        <ActionRow icon={Repeat} tint={c.lime} title={t("calendar.importedRule")} selected trailing={tick(true)} onPress={() => navigation.goBack()} />
      ) : null}
      <ActionRow
        icon={Repeat}
        tint={c.lime}
        title={t("calendar.repeatCustom")}
        subtitle={draft.preset === "custom" ? repeatLabel(draft, locale, say, { none: "", imported: "" }) : undefined}
        selected={draft.preset === "custom"}
        trailing={tick(draft.preset === "custom")}
        onPress={() => {
          // The custom rule starts from what the event repeats now.
          updateDraft(params.formKey, (d) => ({
            ...d,
            custom: d.preset === "custom" ? d.custom : formFor(draftRule(d), d.startDay),
            preset: "custom",
            ruleTouched: true,
          }));
          navigation.replace("eventRule", { formKey: params.formKey });
        }}
      />
    </Sheet>
  );
}
