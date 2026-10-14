/**
 * A conversation's details (the ⓘ of mockup 13): its face, name and topic; how much it notifies me,
 * saved the moment it is chosen; its pinned messages, for a channel; and who is in it.
 *
 * Read-only otherwise: renaming, the topic and membership stay on the web for now.
 */
import {
  getChannels,
  getDirectMessages,
  getReadCursors,
  listChannelMembers,
  saveConversationNotify,
  type ConversationNotify,
  type Member,
  type NotifyLevel,
} from "@ruchoir/client";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { Toggle } from "../../ui/Toggle";
import { useReloadOn } from "../../data/useReloadOn";
import { affects } from "../../realtime/events";

const LEVELS: { level: NotifyLevel; label: ReturnType<typeof key>; hint: ReturnType<typeof key> }[] = [
  { level: "default", label: key("details.levelDefault"), hint: key("details.levelDefaultHint") },
  { level: "all", label: key("details.levelAll"), hint: key("details.levelAllHint") },
  { level: "mentions", label: key("details.levelMentions"), hint: key("details.levelMentionsHint") },
  { level: "none", label: key("details.levelNone"), hint: key("details.levelNoneHint") },
];

const ROLE: Record<string, ReturnType<typeof key> | undefined> = {
  owner: key("details.roleOwner"),
  admin: key("details.roleAdmin"),
  guest: key("invite.guest"),
};

export function ConversationDetails() {
  const { params } = useRoute<RouteProp<RootParams, "conversationDetails">>();
  const { conversationId, channelId, title } = params;
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const toast = useToast();
  const { current } = useSpace();
  const space = current?.id;
  const people = useSpaceMembers(space);

  const channels = useLoad(space && channelId ? `channels:${space}` : null, (signal) => getChannels(space!, signal));
  const dms = useLoad(space && !channelId ? `dms:${space}` : null, (signal) => getDirectMessages(space!, signal));
  const channel = channels.data?.find((ch) => ch.id === channelId);
  const dm = dms.data?.find((d) => d.id === conversationId);
  // A channel lists its people; a private conversation's people are those who have a read cursor in it.
  const channelMembers = useLoad(channelId ? `channelMembers:${channelId}` : null, (signal) => listChannelMembers(channelId!, signal));
  const cursors = useLoad(channelId ? null : `read:${conversationId}`, (signal) => getReadCursors(conversationId, signal));
  // What this page shows, as it changes elsewhere: the channel itself, its people, who read.
  useReloadOn((e) => !!space && affects.channels(e, space), channels.reload);
  useReloadOn((e) => !!space && affects.conversations(e, space), dms.reload);
  useReloadOn((e) => !!channelId && affects.channelMembers(e, channelId), channelMembers.reload);
  useReloadOn((e) => e.type === "readCursor" && e.conversationId === conversationId, cursors.reload);
  const members = channelId
    ? channelMembers
    : {
        ...cursors,
        data:
          cursors.data && people.list.length > 0
            ? cursors.data.flatMap((cur): Member[] => people.list.filter((m) => m.userId === cur.userId))
            : undefined,
      };

  // What I chose here, ahead of what the server last said.
  const [chosen, setChosen] = useState<ConversationNotify | null>(null);
  const notify: ConversationNotify = chosen ?? channel?.notify ?? dm?.notify ?? { level: "default", muted: false };
  const save = (next: ConversationNotify) => {
    const before = notify;
    setChosen(next);
    saveConversationNotify(conversationId, next).catch(() => {
      setChosen(before);
      toast(t("details.saveFailed"));
    });
  };

  const other = dm?.userId ? people.list.find((m) => m.userId === dm.userId) : undefined;
  const loaded = channelId ? channels.data : dms.data;
  const subtitle = channel?.topic ?? other?.title;

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      <BackHeader title={t("details.title")} />
      {!loaded ? (
        <LoadState error={(channelId ? channels : dms).error} onRetry={(channelId ? channels : dms).reload} />
      ) : (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.hero}>
            <Avatar
              name={title}
              kind={channelId ? "workspace" : "person"}
              src={other?.avatarUrl}
              presence={dm?.userId ? dm.presence : undefined}
              size={72}
            />
            <Text variant="title" style={styles.center}>
              {channelId ? `#${title}` : title}
            </Text>
            {subtitle ? (
              <Text tone="body" style={styles.center}>
                {subtitle}
              </Text>
            ) : null}
          </View>

          <Section label={t("details.notifications")}>
            {channelId ? (
              LEVELS.map(({ level, label, hint }) => {
                const on = notify.level === level;
                return (
                  <ActionRow
                    key={level}
                    title={t(label)}
                    subtitle={t(hint)}
                    selected={on}
                    onPress={() => save({ ...notify, level })}
                    trailing={
                      <View style={[styles.radio, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>
                        {on ? <Check size={14} color={c.onInk} /> : null}
                      </View>
                    }
                  />
                );
              })
            ) : (
              <ActionRow
                title={t("details.mute")}
                subtitle={t("details.muteHint")}
                trailing={
                  <Toggle
                    value={notify.muted}
                    onValueChange={(muted) => save({ ...notify, muted })}
                    accessibilityLabel={t("details.mute")}
                  />
                }
              />
            )}
          </Section>

          <Section label={members.data ? t("details.membersCount", { count: members.data.length }) : t("details.members")}>
            {!members.data ? (
              <LoadState error={members.error} onRetry={members.reload} />
            ) : (
              members.data.map((m) => {
                const role = ROLE[m.role];
                return (
                  <ActionRow
                    key={m.userId}
                    leading={<Avatar name={m.name} src={m.avatarUrl} kind={m.bot ? "bot" : "person"} size={40} />}
                    title={m.name}
                    subtitle={m.title}
                    trailing={
                      role ? (
                        <Text variant="tiny" tone="muted" style={[styles.role, { backgroundColor: s.sunken }]}>
                          {t(role)}
                        </Text>
                      ) : undefined
                    }
                  />
                );
              })
            )}
          </Section>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={styles.section}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { gap: 20, paddingHorizontal: 16, paddingBottom: 32 },
  hero: { alignItems: "center", gap: 8, paddingTop: 8 },
  center: { textAlign: "center" },
  section: { gap: 8 },
  card: { borderWidth: hairline, borderRadius: radius.l, paddingHorizontal: 12, paddingVertical: 4 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  shrink: { flexShrink: 1 },
  role: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.s, overflow: "hidden" },
});
