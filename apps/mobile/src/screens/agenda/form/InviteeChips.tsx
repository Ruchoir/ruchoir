import type { AttendeeStatus } from "@ruchoir/client";
import { Check, Clock, HelpCircle, Mail, X } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { key, useTranslation } from "../../../i18n";
import type { DraftAttendee } from "../../../logic/eventForm";
import { hairline } from "../../../theme/tokens";
import { useTheme } from "../../../theme/useTheme";
import { Avatar } from "../../../ui/Avatar";
import { Text } from "../../../ui/Text";
import { updateDraft } from "./draftStore";

const STATUS_TEXT: Record<AttendeeStatus, ReturnType<typeof key>> = {
  accepted: key("attendee.accepted"),
  tentative: key("attendee.tentative"),
  declined: key("attendee.declined"),
  needs_action: key("attendee.needsAction"),
};

/** The people invited, as chips (mockup 19): a face or an envelope, the name, their answer once they
 *  gave one (on a change), and a cross. */
export function InviteeChips({ formKey, attendees }: { formKey: string; attendees: DraftAttendee[] }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const look: Record<AttendeeStatus, { icon: typeof Check; color: string }> = {
    accepted: { icon: Check, color: c.lime },
    tentative: { icon: HelpCircle, color: c.sun },
    declined: { icon: X, color: c.peach },
    needs_action: { icon: Clock, color: s.sunken },
  };
  return (
    <View style={styles.wrap}>
      {attendees.map((a) => {
        const status = a.status && a.status !== "needs_action" ? look[a.status] : null;
        return (
          <View
            key={a.key}
            style={[styles.chip, { borderColor: c.line, backgroundColor: c.surface }]}
            accessible
            accessibilityLabel={a.status ? `${a.name}, ${t(STATUS_TEXT[a.status])}` : a.name}
          >
            {a.userId ? <Avatar name={a.name} size={24} /> : <Mail size={16} color={c.ink} style={styles.mail} />}
            <Text variant="small" numberOfLines={1} style={styles.name}>
              {a.name}
            </Text>
            {status ? (
              <View style={[styles.status, { backgroundColor: status.color }]}>
                <status.icon size={10} color={c.onPastel} />
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("attach.remove", { name: a.name })}
              hitSlop={8}
              onPress={() =>
                updateDraft(formKey, (d) => ({ ...d, attendees: d.attendees.filter((x) => x.key !== a.key), attendeesTouched: true }))
              }
            >
              <X size={14} color={c.ink} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingVertical: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingLeft: 4, paddingRight: 10, paddingVertical: 4, borderRadius: 999, borderWidth: hairline },
  mail: { marginLeft: 4 },
  name: { flexShrink: 1 },
  status: { width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
