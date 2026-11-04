/**
 * A space's Members section (mockup 2): who is in it with their roles as pastilles, the guests with
 * the day their access ends, a lock on the people the caller cannot manage, the filters Tous /
 * Membres / Invités, a search, the invitation in the header, and at the end the accesses that ended
 * and can be reactivated. A person opens as the member screen.
 */
import { refusalOf, type EndedAccess, type Group, type Member, type Role, type Workspace } from "@ruchoir/client";
import { canSeeEnded, presetToInstant, type EndChoice } from "@ruchoir/client/permissionsLogic";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ChevronRight, Clock, Lock, RotateCcw, UserPlus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import {
  deviceZone,
  endedRowText,
  filterCounts,
  filterPeople,
  heldRoles,
  roleColourKey,
  rowAccess,
  shortDay,
  systemRoleKey,
  type PeopleFilter,
} from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import { canAdminister, matchesMember, memberCounts } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { memberDoors } from "../../logic/sectionGuard";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { Chips } from "../../ui/Chips";
import { feel } from "../../ui/haptics";
import { RoleChip } from "../../ui/RoleChip";
import { SearchField } from "../../ui/SearchField";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** The legacy roles: what an instance older than the roles says, and the owner's and the guests' pastilles. */
export const LEGACY_LABEL = {
  owner: key("details.roleOwner"),
  admin: key("details.roleAdmin"),
  member: key("invite.member"),
  guest: key("invite.guest"),
} as const;

export const SYSTEM_ROLE_LABEL = {
  "role.admin": key("role.admin"),
  "roles.everyone": key("roles.everyone"),
  "roles.guests": key("roles.guests"),
} as const;

/** The ends offered when an ended access comes back. */
const REVIVE_CHOICES: { choice: EndChoice; label: ReturnType<typeof key> }[] = [
  { choice: "week", label: key("guests.presetWeek") },
  { choice: "month", label: key("guests.presetMonth") },
  { choice: "quarter", label: key("guests.presetQuarter") },
  { choice: "none", label: key("guests.presetNoEnd") },
];

export function SpaceMembersScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("members");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Members space={current} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Members({ space }: { space: Workspace }) {
  const { getSpaceMembers, listRoles, listGroups, listEndedAccess } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const session = useSession();
  const { gates, rights, supported } = useRights();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const roles = useLoad(supported ? `roles:${space.id}` : null, () => listRoles(space.id));
  // Groups give roles, and only some people may list them: a refusal reads as none.
  const groups = useLoad(supported ? `groups:${space.id}` : null, () => listGroups(space.id).catch(() => [] as Group[]));
  const allowedEnded = supported && canSeeEnded(rights);
  const ended = useLoad(allowedEnded ? `ended:${space.id}` : null, (signal) => listEndedAccess(space.id, signal));
  const toast = useToast();
  const endedFailed = !!ended.error;
  useEffect(() => {
    if (endedFailed) toast(t("guests.endedLoadFailed"), "failure");
  }, [endedFailed, toast, t]);
  const { reload } = members;
  const reloadAll = useCallback(() => {
    members.reload();
    roles.reload();
    groups.reload();
    ended.reload();
  }, [members, roles, groups, ended]);
  // Someone joining, leaving or changing role, or the roles themselves, here or elsewhere; and back from a member's screen.
  useReloadOn((e) => affects.members(e, space.id) || affects.permissions(e, space.id), reloadAll, 300);
  useFocusEffect(useCallback(() => reload(), [reload]));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>("all");
  const me = session.state.kind === "signedIn" ? session.state.user.id : undefined;
  const list = members.data;
  const counts = useMemo(() => (list ? filterCounts(list) : null), [list]);
  const totals = list ? memberCounts(list) : null;
  const summary = totals
    ? [
        t("details.membersCount", { count: totals.people }),
        totals.guests > 0 ? t("spaceAdmin.guests", { count: totals.guests }) : null,
        totals.bots > 0 ? t("spaceAdmin.bots", { count: totals.bots }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const mayInvite = memberDoors(supported, gates, canAdminister(space.role)).invite;
  const shown = list ? filterPeople(list, filter).filter((m) => matchesMember(m, query)) : [];

  return (
    <>
      <BackHeader
        title={t("details.members")}
        subtitle={summary}
        trailing={
          mayInvite ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("spaceAdmin.invite")} hitSlop={8} onPress={() => navigation.navigate("invite")} style={styles.invite}>
              <UserPlus size={22} color={c.ink} />
            </Pressable>
          ) : undefined
        }
      />
      {!list || !counts ? (
        <LoadState error={members.error} onRetry={reload} />
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(m) => m.userId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View style={styles.head}>
              {supported ? (
                <Chips
                  gutter={0}
                  value={filter}
                  onChange={setFilter}
                  chips={[
                    { key: "all", label: t("members.filterAll"), count: counts.all },
                    { key: "members", label: t("details.members"), count: counts.members },
                    { key: "guests", label: t("guests.sectionTitle"), count: counts.guests },
                  ]}
                />
              ) : null}
              <SearchField value={query} onChange={setQuery} placeholder={t("spaceAdmin.search")} style={styles.search} />
            </View>
          }
          ListEmptyComponent={
            <Text tone="muted" style={styles.empty}>
              {t("spaceAdmin.noMatch")}
            </Text>
          }
          ListFooterComponent={
            allowedEnded && ended.data && ended.data.length > 0 ? (
              <EndedBlock space={space} items={ended.data} onChanged={reloadAll} onFailed={ended.reload} />
            ) : null
          }
          renderItem={({ item: m }) => (
            <PersonRow member={m} me={me} space={space} roles={roles.data ?? []} groups={groups.data ?? []} supported={supported} manages={rights.includes("members.manage")} />
          )}
        />
      )}
    </>
  );
}

type Pastille = { id: string; label: string; colour: ReturnType<typeof roleColourKey>; viaGroup?: boolean };

function PersonRow({ member: m, me, space, roles, groups, supported, manages }: { member: Member; me?: string; space: Workspace; roles: Role[]; groups: Group[]; supported: boolean; manages: boolean }) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const mine = m.userId === me;
  // An older server says nothing of `manageable`: the legacy ranks decide who opens.
  const access = supported ? rowAccess(m, me, manages) : m.bot ? "none" : mine || m.role === "owner" || m.role === space.role ? "locked" : "open";
  const held = supported ? heldRoles(m, roles, groups) : [];
  const chips: Pastille[] = [];
  if (m.bot) {
    chips.push({ id: "bot", label: t("spaceAdmin.bot"), colour: "line" });
  } else if (!supported) {
    chips.push({ id: "legacy", label: t(LEGACY_LABEL[m.role as keyof typeof LEGACY_LABEL] ?? LEGACY_LABEL.member), colour: "line" });
  } else {
    if (m.role === "owner") chips.push({ id: "owner", label: t(LEGACY_LABEL.owner), colour: "violet" });
    if (m.role === "guest") chips.push({ id: "guest", label: t(LEGACY_LABEL.guest), colour: "sky" });
    for (const { role, via } of held) {
      const named = systemRoleKey(role);
      chips.push({ id: role.id, label: named ? t(SYSTEM_ROLE_LABEL[named]) : role.name, colour: roleColourKey(role), viaGroup: via.length > 0 });
    }
  }
  const noRole = supported && !m.bot && m.role === "member" && held.length === 0;
  const zone = deviceZone();
  const open = access === "open" ? () => navigation.navigate("spaceMember", { userId: m.userId }) : undefined;
  return (
    <Pressable
      disabled={!open}
      onPress={open}
      accessibilityRole={open ? "button" : undefined}
      accessibilityLabel={access === "locked" ? `${m.name}, ${mine ? t("roles.selfLocked") : t("roles.aboveYou")}` : m.name}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: s.pressed }]}
    >
      <Avatar name={m.name} src={m.avatarUrl} kind={m.bot ? "bot" : "person"} size={40} />
      <View style={styles.text}>
        <View style={styles.nameLine}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
            {m.name}
          </Text>
          {mine ? (
            <View style={[styles.you, { borderColor: c.lineStrong }]}>
              <Text variant="tiny" tone="muted">
                {t("spaceAdmin.you")}
              </Text>
            </View>
          ) : null}
        </View>
        {chips.length > 0 ? (
          <View style={styles.chips}>
            {chips.map((chip) => (
              <RoleChip key={chip.id} label={chip.label} colour={chip.colour} viaGroup={chip.viaGroup} />
            ))}
          </View>
        ) : null}
        {noRole ? (
          <Text variant="tiny" tone="muted">
            {t("roles.membersOnly")}
          </Text>
        ) : null}
        {supported && m.role === "guest" ? (
          <View style={styles.until}>
            <Clock size={12} color={c.muted} />
            <Text variant="tiny" tone="muted">
              {m.expiresAt ? t("files.linkUntil", { date: shortDay(m.expiresAt, locale, zone, new Date()) }) : t("guests.noEnd")}
            </Text>
          </View>
        ) : null}
        {!supported && m.title ? (
          <Text variant="tiny" tone="muted" numberOfLines={1}>
            {m.title}
          </Text>
        ) : null}
      </View>
      {access === "locked" ? <Lock size={18} color={c.muted} /> : access === "open" ? <ChevronRight size={20} color={c.muted} /> : null}
    </Pressable>
  );
}

/** The accesses that ended and are kept 90 days (mockup 2, right): who, when it ended, and Réactiver. */
function EndedBlock({ space, items, onChanged, onFailed }: { space: Workspace; items: EndedAccess[]; onChanged: () => void; onFailed: () => void }) {
  const { reactivateGuest } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const toast = useToast();
  const [reviving, setReviving] = useState<{ userId: string; choice: EndChoice } | null>(null);
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const zone = deviceZone();

  const revive = async (userId: string, choice: EndChoice) => {
    setBusy(true);
    try {
      await reactivateGuest(space.id, userId, presetToInstant(choice, new Date(), zone));
      toast(t("guests.reactivated"), "success");
      setReviving(null);
      onChanged();
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      toast(said ? String(t(said.key as never, said.vars as never)) : t("guests.reactivateFailed"), "failure");
      // Whatever the list said, the server knows better now.
      onFailed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.ended, { borderColor: c.lineStrong }]}>
      <View style={styles.endedHead}>
        <Text variant="label" tone="muted">
          {t("guests.endedTitle")}
        </Text>
        <Text variant="tiny" tone="muted">
          {t("guests.endedKeep")}
        </Text>
      </View>
      <Text variant="small" tone="muted">
        {t("guests.endedNote")}
      </Text>
      {items.map((item) => {
        const text = endedRowText(item, now, locale, zone);
        const open = reviving?.userId === item.userId;
        return (
          <View key={item.userId} style={styles.endedItem}>
            <View style={styles.endedRow}>
              <Avatar name={item.name} size={40} />
              <View style={styles.text}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {text.name}
                </Text>
                <Text variant="tiny" tone="muted" numberOfLines={1}>
                  {[t("guests.endedOn", { date: text.endedOn }), text.ago].join(" · ")}
                </Text>
              </View>
              <Button
                size="sm"
                variant="secondary"
                label={t("guests.reactivate")}
                icon={<RotateCcw size={14} color={c.ink} />}
                onPress={() => {
                  feel("choice");
                  setReviving(open ? null : { userId: item.userId, choice: "month" });
                }}
              />
            </View>
            {open && reviving ? (
              <View style={[styles.revive, { backgroundColor: s.sunken }]}>
                <Text variant="smallStrong">{t("guests.reactivateTitle", { name: item.name })}</Text>
                <Text variant="small" tone="muted">
                  {t("guests.reactivateNote")}
                </Text>
                <View style={styles.wrap}>
                  {REVIVE_CHOICES.map(({ choice, label }) => {
                    const on = reviving.choice === choice;
                    return (
                      <Pressable
                        key={String(choice)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        onPress={() => {
                          feel("choice");
                          setReviving({ userId: item.userId, choice });
                        }}
                        style={[styles.pill, { borderColor: on ? s.edge : c.lineStrong, backgroundColor: on ? s.selected : c.surface }]}
                      >
                        <Text variant={on ? "smallStrong" : "small"}>{t(label)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Button label={t("guests.reactivate")} size="md" busy={busy} onPress={() => void revive(item.userId, reviving.choice)} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    list: { paddingBottom: 32 },
    head: { gap: 10, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 16 },
    search: { marginHorizontal: 0 },
    empty: { paddingVertical: 16, textAlign: "center" },
    invite: { padding: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
    text: { flex: 1, minWidth: 0, gap: 4 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1 },
    you: { borderWidth: shape.hairline, borderStyle: "dashed", borderRadius: 8, paddingHorizontal: 6 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    until: { flexDirection: "row", alignItems: "center", gap: 4 },
    ended: { marginTop: 18, marginHorizontal: 16, paddingTop: 14, gap: 8, borderTopWidth: shape.hairline },
    endedHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    endedItem: { gap: 8 },
    endedRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 },
    revive: { gap: 10, padding: 12, borderRadius: shape.radius.m },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    pill: { height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
  }),
);
