/**
 * A conversation's details (the ⓘ of mockup 13): its face, name and topic; how much it notifies me,
 * saved the moment it is chosen; its pinned messages, for a channel; and who is in it.
 *
 * For a channel, what the web's channel menu and settings offer: keeping it among my favourites,
 * editing it (name, topic, access, archiving), adding people of the space, inviting someone from
 * outside, leaving it; for whoever runs it, a member's role and taking them out. For the space's owner
 * and administrators, deleting the channel (not the space's default channel).
 *
 * My role in the channel is my own row of its people, and the space's owner and administrators count
 * as its owner, which is how the API reads them. The ranks only decide what is offered; the API is
 * the guard and a refusal is said.
 */
import type { ConversationNotify, Member, NotifyLevel } from "@ruchoir/client";
import { StackActions, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, LogOut, Mail, Pencil, Star, Trash2, UserPlus } from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useSpaceMembers } from "../../data/members";
import { useLoad } from "../../data/useLoad";
import { key, useTranslation } from "../../i18n";
import { canAdminister } from "../../logic/spaceRoles";
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
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { feel } from "../../ui/haptics";
import { useSession } from "../../session/SessionProvider";
import { channelRank, grantableChannelRoles } from "../../logic/channelRoles";
import { deletedHere } from "./deletedHere";
import { PeoplePickerModal } from "./PeoplePickerModal";

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

/** What a channel role is called when it is offered. */
const CHANNEL_ROLE: Record<string, ReturnType<typeof key>> = {
  member: key("details.makeMember"),
  admin: key("details.makeModerator"),
  owner: key("details.makeOwner"),
};

export function ConversationDetails() {
  const { addChannelMembers, deleteChannel, getChannels, getDirectMessages, getReadCursors, leaveChannel, listChannelMembers, removeChannelMember, saveConversationNotify, setChannelFavorite, setChannelMemberRole } = useApi();
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
      toast(t("details.saveFailed"), "failure");
    });
  };

  const other = dm?.userId ? people.list.find((m) => m.userId === dm.userId) : undefined;
  const loaded = channelId ? channels.data : dms.data;
  const subtitle = channel?.topic ?? other?.title;

  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { emit } = useRealtimeActions();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const isChannel = !!channelId && !!channel;
  const guest = current?.role === "guest";
  const archived = channel?.type === "archived";
  // The space's owner and admins run every channel; anyone else holds the role of their own row.
  const myChannelRole = canAdminister(current?.role)
    ? "owner"
    : guest
      ? "member"
      : (channelMembers.data?.find((m) => m.userId === me)?.role ?? "member");
  const runs = channelRank(myChannelRole) >= channelRank("admin");

  const [fav, setFav] = useState<boolean | null>(null);
  const favourite = fav ?? channel?.fav ?? false;
  const toggleFavourite = (next: boolean) => {
    if (!channelId) return;
    setFav(next);
    setChannelFavorite(channelId, next).then(
      () => space && emit({ type: "channels", spaceId: space, channelId }),
      () => {
        setFav(!next);
        toast(t("details.favouriteFailed"), "failure");
      },
    );
  };

  const [adding, setAdding] = useState(false);
  const inChannel = new Set((channelMembers.data ?? []).map((m) => m.userId));
  const addable = people.list.filter((m) => !m.bot && !inChannel.has(m.userId));
  const add = (ids: string[]) => {
    setAdding(false);
    if (!channelId || ids.length === 0) return;
    addChannelMembers(channelId, ids).then(
      () => {
        feel("success");
        toast(t("details.added", { count: ids.length }), "success");
        channelMembers.reload();
      },
      () => toast(t("details.addFailed"), "failure"),
    );
  };

  const leave = () => {
    if (!channelId || !space) return;
    feel("warning");
    Alert.alert(t("details.leaveTitle", { name: title }), channel?.type === "private" ? t("details.leavePrivate") : t("details.leavePublic"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("spaceAdmin.leaveConfirm"),
        style: "destructive",
        onPress: () => {
          leaveChannel(channelId).then(
            () => {
              toast(t("details.left", { name: title }));
              navigation.dispatch(StackActions.popToTop());
              if (me) emit({ type: "channels", spaceId: space, channelId, membership: { userId: me, change: "left" } });
            },
            () => toast(t("details.leaveFailed"), "failure"),
          );
        },
      },
    ]);
  };

  /** The role and the way out of a channel, for someone ranked below me in it. */
  const manage = (m: Member) => {
    if (!channelId) return;
    const roles = grantableChannelRoles(myChannelRole, m.role).filter((role) => role !== m.role);
    feel("menu");
    Alert.alert(m.name, undefined, [
      ...roles.map((role) => ({
        text: t(CHANNEL_ROLE[role]!),
        onPress: () => {
          setChannelMemberRole(channelId, m.userId, role).then(
            () => {
              toast(t("details.roleChanged", { name: m.name }));
              channelMembers.reload();
            },
            () => toast(t("details.roleFailed"), "failure"),
          );
        },
      })),
      {
        text: t("details.remove"),
        style: "destructive" as const,
        onPress: () => {
          removeChannelMember(channelId, m.userId).then(
            () => {
              toast(t("details.removed", { name: m.name }));
              channelMembers.reload();
            },
            () => toast(t("details.removeFailed"), "failure"),
          );
        },
      },
      { text: t("compose.cancel"), style: "cancel" as const },
    ]);
  };
  const mayDelete = !!channelId && !!current && canAdminister(current.role);
  const isDefault = !!channelId && current?.defaultChannelId === channelId;
  const remove = () => {
    if (!channelId || !space) return;
    feel("warning");
    Alert.alert(t("details.deleteTitle", { name: title }), t("details.deleteHint"), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("compose.delete"),
        style: "destructive",
        onPress: () => {
          deletedHere.add(channelId);
          deleteChannel(channelId).then(
            () => {
              toast(t("details.deleted"), "success");
              navigation.dispatch(StackActions.popToTop());
              emit({ type: "channels", spaceId: space, channelId, deleted: true });
            },
            () => {
              deletedHere.delete(channelId);
              toast(t("details.deleteFailed"), "failure");
            },
          );
        },
      },
    ]);
  };

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

          {isChannel ? (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
              <ActionRow
                icon={Star}
                tint={c.sun}
                title={t("files.favourite")}
                subtitle={t("details.favouriteHint")}
                trailing={<Toggle value={favourite} onValueChange={toggleFavourite} accessibilityLabel={t("files.favourite")} />}
              />
              {!guest ? (
                <ActionRow icon={Pencil} title={t("details.edit")} subtitle={t("details.editHint")} onPress={() => navigation.navigate("channelEdit", { channelId: channelId! })} />
              ) : null}
              {runs && !archived && channel?.type === "private" ? (
                <ActionRow icon={UserPlus} tint={c.pink} title={t("details.addPeople")} subtitle={t("details.addPeopleHint")} onPress={() => setAdding(true)} />
              ) : null}
              {runs && !archived ? (
                <ActionRow
                  icon={Mail}
                  tint={c.pink}
                  title={t("details.inviteOutside")}
                  subtitle={t("details.inviteOutsideHint")}
                  onPress={() => navigation.navigate("channelInvite", { channelId: channelId!, title })}
                />
              ) : null}
            </View>
          ) : null}

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
                const mayManage =
                  isChannel && m.userId !== me && channelRank(m.role) < channelRank(myChannelRole) && channelRank(myChannelRole) >= channelRank("admin");
                return (
                  <ActionRow
                    key={m.userId}
                    onPress={mayManage ? () => manage(m) : undefined}
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

          {isChannel ? (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
              <ActionRow icon={LogOut} danger title={t("details.leave")} subtitle={t("details.leaveHint")} onPress={leave} />
            </View>
          ) : null}

          {mayDelete ? (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
              {isDefault ? (
                <ActionRow icon={Trash2} title={t("details.delete")} subtitle={t("details.deleteDefault")} />
              ) : (
                <ActionRow icon={Trash2} danger title={t("details.delete")} subtitle={t("details.deleteHint")} onPress={remove} />
              )}
            </View>
          ) : null}
        </ScrollView>
      )}
      {adding ? (
        <PeoplePickerModal title={t("details.addPeople")} people={addable} selected={[]} onDone={add} onClose={() => setAdding(false)} />
      ) : null}
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
