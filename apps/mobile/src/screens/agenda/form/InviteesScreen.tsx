import type { Invitee } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Mail } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../../api/useApi";
import { useTranslation } from "../../../i18n";
import { isEmail } from "../../../logic/email";
import type { DraftAttendee } from "../../../logic/eventForm";
import type { RootParams } from "../../../navigation/types";
import { useTheme } from "../../../theme/useTheme";
import { ActionRow } from "../../../ui/ActionRow";
import { Avatar } from "../../../ui/Avatar";
import { Button } from "../../../ui/Button";
import { SearchField } from "../../../ui/SearchField";
import { SheetHeader } from "../../../ui/SheetHeader";
import { Text } from "../../../ui/Text";
import { updateDraft, useDraft } from "./draftStore";
import { InviteeChips } from "./InviteeChips";

/**
 * Who is invited (the web's `AttendeesField`): the people the calendar may invite, searched as one
 * types (all of them before), and an address typed in full, invited by e-mail. Those already on the
 * list sit on top, each removable.
 */
export function InviteesScreen() {
  const { searchInvitees } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "eventInvitees">>();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const draft = useDraft(params.formKey);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Invitee[]>([]);
  const calendarId = draft?.calendarId;

  // Suggestions follow what is typed, a moment after the last key.
  useEffect(() => {
    if (!calendarId) return;
    const abort = new AbortController();
    const wait = setTimeout(() => {
      searchInvitees(calendarId, text.trim(), abort.signal).then(setFound, () => {});
    }, 250);
    return () => {
      clearTimeout(wait);
      abort.abort();
    };
  }, [calendarId, searchInvitees, text]);

  if (!draft) return null;
  const add = (attendee: DraftAttendee) => {
    updateDraft(params.formKey, (d) =>
      d.attendees.some((a) => a.key === attendee.key) ? d : { ...d, attendees: [...d.attendees, attendee], attendeesTouched: true },
    );
    setText("");
  };
  const typed = text.trim();
  const byAddress = isEmail(typed) && !draft.attendees.some((a) => (a.email ?? "").toLowerCase() === typed.toLowerCase());
  const suggestions = found.filter((p) => !draft.attendees.some((a) => a.userId === p.userId));

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("calendar.attendees")} onClose={() => navigation.goBack()} />
      <SearchField value={text} onChange={setText} placeholder={t("eventForm.searchPeople")} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {draft.attendees.length > 0 ? <InviteeChips formKey={params.formKey} attendees={draft.attendees} /> : null}
        {byAddress ? (
          <ActionRow icon={Mail} tint={c.sun} title={t("calendar.inviteByEmail", { email: typed })} onPress={() => add({ key: typed, email: typed, name: typed })} />
        ) : null}
        {suggestions.map((person) => (
          <ActionRow
            key={person.userId}
            leading={<Avatar name={person.name} size={40} />}
            title={person.name}
            onPress={() => add({ key: person.userId, userId: person.userId, name: person.name })}
          />
        ))}
        {draft.attendees.length > 0 ? (
          <Text variant="tiny" tone="muted">
            {t("eventForm.inviteNote")}
          </Text>
        ) : null}
        <Button label={t("group.pickDone")} onPress={() => navigation.goBack()} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, gap: 4 },
});
