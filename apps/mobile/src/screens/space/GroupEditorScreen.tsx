/**
 * A group's editor (mockup frame 7, right): its people, with Ajouter through the people picker and a
 * menu on each row; the roles its members receive, as toggles saved at once (those above the caller's
 * own locked, with the reason); its managers; the name, and Supprimer. Every action shows only where
 * the group's `may` block allows it, so someone who manages only some groups sees only those actions.
 * A group mirrored from a directory keeps its people and managers there (read only), as on the web.
 */
import { refusalOf, type Group, type Member, type Role } from "@ruchoir/client";
import { additionLockKey, groupPeople, groupRow, groupTagFor, guestCeilingApplies, usedInRows } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { groupAbilities, pickablePeople, personActions, roleToggleRows, settledRoles, togglePayload, type PersonAction } from "../../logic/groupEditor";
import { roleColourKey } from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { feel } from "../../ui/haptics";
import { RoleChip } from "../../ui/RoleChip";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { Toggle } from "../../ui/Toggle";
import { useToast } from "../../ui/Toast";
import { PeoplePickerModal } from "../discussions/PeoplePickerModal";
import { GroupTag, GroupTile, useRoleLabel } from "./GroupParts";

export function GroupEditorScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("groups");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Editor spaceId={current.id} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Editor({ spaceId }: { spaceId: string }) {
  const { listGroups, listRoles, getSpaceMembers } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "groupEditor">>();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const toast = useToast();
  const groups = useLoad(`groups:${spaceId}`, () => listGroups(spaceId));
  const roles = useLoad(`roles:${spaceId}`, () => listRoles(spaceId));
  const members = useLoad(`members:${spaceId}`, (signal) => getSpaceMembers(spaceId, signal));
  const { reload: reloadGroups } = groups;
  const { reload: reloadRoles } = roles;
  const { reload: reloadMembers } = members;
  const reloadAll = useCallback(() => {
    reloadGroups();
    reloadRoles();
    reloadMembers();
  }, [reloadGroups, reloadRoles, reloadMembers]);
  // The group, its people, the roles or the caller's own rights changed here or elsewhere: read them again.
  useReloadOn((e) => affects.permissions(e, spaceId), reloadAll, 300);
  // Back from the name sheet (or the picker's work): what was saved there is read again. The first
  // focus is the screen opening, whose own load is already on its way.
  useEffect(() => {
    let away = false;
    const stopBlur = navigation.addListener("blur", () => (away = true));
    const stopFocus = navigation.addListener("focus", () => {
      if (away) reloadAll();
      away = false;
    });
    return () => {
      stopBlur();
      stopFocus();
    };
  }, [navigation, reloadAll]);

  const group = groups.data?.find((g) => g.id === params.groupId);
  // A group deleted elsewhere while it was open: nothing left to edit, and the person is told. My own deletion says its own.
  const gone = groups.data !== undefined && !group;
  const leaving = useRef(false);
  useEffect(() => {
    if (!gone || leaving.current) return;
    leaving.current = true;
    toast(t("groups.gone"));
    if (navigation.canGoBack()) navigation.goBack();
  }, [gone, navigation, toast, t]);

  if (!groups.data || !group || !roles.data || !members.data) {
    return (
      <>
        <BackHeader title="" />
        <LoadState error={groups.error ?? roles.error ?? members.error} onRetry={reloadAll} />
      </>
    );
  }
  return <Body spaceId={spaceId} group={group} roles={roles.data} members={members.data} onChanged={reloadAll} onDeleting={() => (leaving.current = true)} />;
}

function Body({
  spaceId,
  group,
  roles,
  members,
  onChanged,
  onDeleting,
}: {
  spaceId: string;
  group: Group;
  roles: Role[];
  members: Member[];
  onChanged: () => void;
  onDeleting: () => void;
}) {
  const { addGroupMembers, removeGroupMember, setGroupManagers, setGroupRoles, deleteGroup } = useApi();
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const session = useSession();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { current } = useSpace();
  const roleLabel = useRoleLabel();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  // The roles as the toggles show them while a change is on its way, so the switch does not spring back.
  const [pending, setPending] = useState<string[] | null>(null);
  // The group as it was when the last role toggle was saved: once a different one arrives, the reload is in.
  const writtenFrom = useRef<Group | null>(null);
  useEffect(() => {
    if (pending && writtenFrom.current && writtenFrom.current !== group) {
      writtenFrom.current = null;
      setPending(null);
    }
  }, [pending, group]);

  const edition = current?.edition ?? "community";
  const licensed = edition !== "community";
  const frozen = edition === "frozen";
  const viewerId = session.state.kind === "signedIn" ? session.state.user.id : "";
  const mine = members.find((m) => m.userId === viewerId);
  const ctx = { licensed, frozen };
  const can = groupAbilities(group, ctx);
  const { people, missing } = groupPeople(group, members);
  const { carries } = groupRow(group, roles, { frozen });
  const directory = group.source === "directory";
  const managers = group.managerIds.map((id) => members.find((m) => m.userId === id)).filter((m): m is Member => !!m);
  const pickable = pickablePeople(members, group, { carriesRoles: licensed && carries.length > 0, viewerId, viewerIsOwner: mine?.role === "owner" });
  const shownRoles = settledRoles(pending, group.roleIds) ?? group.roleIds;
  const toggles = roleToggleRows({ roleIds: shownRoles }, roles, { myTopRoleId: mine?.roleIds?.[0], editable: can.rolesEditable && !busy, additions: can.appointLock });
  const inGroup = group.memberIds.includes(viewerId);
  const list = (names: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);

  const failed = (err: unknown) => {
    const said = refusalSaid(refusalOf(err));
    feel("failure");
    toast(said ? String(t(said.key as never, said.vars as never)) : t("roles.saveFailed"), "failure");
  };

  /** One write, then the screen reads again whether it went through or not. */
  const run = async (write: () => Promise<unknown>, done?: string, keepPending = false) => {
    setBusy(true);
    let ok = false;
    try {
      await write();
      ok = true;
      feel("success");
      if (done) toast(done, "success");
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
      // A saved role toggle keeps its place until the reloaded group agrees (see `settledRoles`); a refused one springs back.
      if (keepPending && ok) writtenFrom.current = group;
      else setPending(null);
      onChanged();
    }
  };

  const add = (ids: string[]) => {
    setPicking(false);
    if (ids.length === 0) return;
    const doIt = () => void run(() => addGroupMembers(spaceId, group.id, ids), t("groups.membersAdded"));
    if (!licensed || carries.length === 0) return doIt();
    // The group carries roles: say who will receive which, and that it goes to the journal, before it is done.
    const picked = new Set(ids);
    const names = list(members.filter((m) => picked.has(m.userId)).map((m) => m.name.split(" ")[0]));
    const rolesText = carries.map(roleLabel).join(", ");
    const vars = { count: ids.length, names, roles: rolesText };
    const sentence = carries.length === 1 ? t("groups.addNoticeRole", vars) : t("groups.addNoticeRoles", vars);
    const ceiling = guestCeilingApplies(members, picked, true) ? `\n\n${t("groups.guestCeiling")}` : "";
    Alert.alert(t("groups.addTitle", { group: group.name }), sentence + ceiling, [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("groups.addConfirm", { count: ids.length }), onPress: doIt },
    ]);
  };

  const act = (action: PersonAction, person: Member) => {
    if (action === "remove") return void run(() => removeGroupMember(spaceId, group.id, person.userId), t("groups.personRemoved"));
    const next = action === "appoint" ? [...group.managerIds, person.userId] : group.managerIds.filter((id) => id !== person.userId);
    return void run(() => setGroupManagers(spaceId, group.id, next));
  };

  const menu = (person: Member, actions: PersonAction[]) => {
    const text: Record<PersonAction, string> = { remove: t("groups.removeAction"), appoint: t("groups.appoint"), unappoint: t("groups.unappoint") };
    Alert.alert(person.name, undefined, [
      ...actions.map((action) => ({ text: text[action], style: action === "remove" ? ("destructive" as const) : ("default" as const), onPress: () => act(action, person) })),
      { text: t("compose.cancel"), style: "cancel" as const },
    ]);
  };

  const toggleRole = (roleId: string, on: boolean) => {
    const next = togglePayload({ roleIds: shownRoles }, roles, roleId, on);
    setPending(next);
    void run(() => setGroupRoles(spaceId, group.id, next), undefined, true);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteGroup(spaceId, group.id);
      onDeleting();
      feel("success");
      toast(t("groups.deleted"), "success");
      navigation.goBack();
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal?.code === "group_has_rules") {
        // Where the rules still name it, so they can be lifted first.
        const where = refusal.usedIn ? usedInRows(refusal.usedIn).map((row) => (row.hidden ? t("access.usedIn.hidden") : (row.label ?? ""))).filter(Boolean) : [];
        feel("warning");
        Alert.alert(t("access.usedIn.warnTitle", { name: group.name }), [t("groups.refusal.hasRules"), ...where].join("\n"));
      } else failed(err);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () =>
    Alert.alert(
      t("groups.deleteTitle", { group: group.name }),
      carries.length > 0 ? t("groups.deleteRoles", { roles: carries.map(roleLabel).join(", "), group: group.name }) : t("groups.deletePlain", { group: group.name }),
      [
        { text: t("compose.cancel"), style: "cancel" },
        { text: t("groups.delete"), style: "destructive", onPress: () => void remove() },
      ],
    );

  const count = t("conversation.people", { count: people.length });
  return (
    <View style={styles.fill}>
      <BackHeader title={group.name} subtitle={group.description ? t("groups.headSub", { description: group.description, people: count }) : count} leading={<GroupTile id={group.id} size={36} />} trailing={groupTagFor(group, members) === "guests" ? <GroupTag label={t("guests.sectionTitle")} /> : undefined} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {directory ? (
          <Text variant="small" tone="body" style={styles.note}>
            <Text variant="smallStrong">{t("groups.directoryAlertStrong")}</Text> {t("groups.directoryAlertRest")}
          </Text>
        ) : null}

        <View style={styles.head}>
          <Text variant="label" tone="muted">
            {t("groups.peopleHead", { count: people.length })}
          </Text>
          {can.add && pickable.length > 0 ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("groups.addTitle", { group: group.name })} accessibilityState={{ disabled: busy || !!can.addLock }} disabled={busy || !!can.addLock} hitSlop={8} onPress={() => setPicking(true)} style={[styles.add, can.addLock ? { opacity: 0.4 } : null]}>
              <Plus size={16} color={s.link} />
              <Text variant="smallStrong" style={{ color: s.link }}>
                {t("group.addExternal")}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {can.add && pickable.length > 0 && can.addLock ? (
          <Text variant="tiny" tone="muted" style={styles.note}>
            {t(additionLockKey(can.addLock))}
          </Text>
        ) : null}
        {people.map((person) => {
          const actions = personActions(group, { viewerId, ...ctx }, person);
          return (
            <View key={person.userId} style={styles.row}>
              <Avatar name={person.name} src={person.avatarUrl} size={36} />
              <View style={styles.text}>
                <View style={styles.nameLine}>
                  <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
                    {person.name}
                  </Text>
                  {group.managerIds.includes(person.userId) ? <GroupTag label={t("groups.manager")} /> : null}
                </View>
                {person.title ? (
                  <Text variant="tiny" tone="muted" numberOfLines={1}>
                    {person.title}
                  </Text>
                ) : null}
              </View>
              {actions.length > 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t("groups.menuFor", { name: person.name })} disabled={busy} hitSlop={8} onPress={() => menu(person, actions)} style={styles.more}>
                  <MoreHorizontal size={22} color={c.muted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
        {missing > 0 ? (
          <Text variant="tiny" tone="muted" style={styles.note}>
            {t("audit.formerMembers", { count: missing })}
          </Text>
        ) : null}

        {can.roles ? (
          <>
            <Text variant="label" tone="muted" style={styles.section}>
              {t("groups.membersReceive")}
            </Text>
            {can.appointLock ? (
              <Text variant="small" tone="muted" style={styles.note}>
                {t(additionLockKey(can.appointLock))}
              </Text>
            ) : null}
            {toggles.map(({ role, on, lock, licenceLock, enabled }) => (
              <View key={role.id} style={styles.row}>
                <View style={styles.text}>
                  <RoleChip label={roleLabel(role)} colour={roleColourKey(role)} />
                  {lock ? (
                    <Text variant="tiny" tone="muted" style={styles.reason}>
                      {lock === "yourTop" ? t("roles.yourTopRole") : t("roles.aboveYou")}
                    </Text>
                  ) : licenceLock ? (
                    <Text variant="tiny" tone="muted" style={styles.reason}>
                      {t(additionLockKey(licenceLock))}
                    </Text>
                  ) : null}
                </View>
                <Toggle accessibilityLabel={roleLabel(role)} value={on} disabled={!enabled} onValueChange={(next) => toggleRole(role.id, next)} />
              </View>
            ))}
            {can.rolesEditable && inGroup ? (
              <Text variant="tiny" tone="muted" style={styles.note}>
                {t("groups.noSelfRole")}
              </Text>
            ) : null}
          </>
        ) : null}

        {can.managers ? (
          <>
            <Text variant="label" tone="muted" style={styles.section}>
              {t("groups.managersHead")}
            </Text>
            {can.appointLock ? (
              <Text variant="tiny" tone="muted" style={styles.note}>
                {t(additionLockKey(can.appointLock))}
              </Text>
            ) : null}
            {managers.length === 0 ? (
              <Text variant="small" tone="muted" style={styles.note}>
                {t("groups.managersEmpty")}
              </Text>
            ) : (
              managers.map((person) => (
                <View key={person.userId} style={styles.row}>
                  <Avatar name={person.name} src={person.avatarUrl} size={32} />
                  <Text variant="bodyStrong" numberOfLines={1} style={styles.text}>
                    {person.name}
                  </Text>
                </View>
              ))
            )}
          </>
        ) : null}

        {can.rename || can.delete ? (
          <View style={[styles.actions, { borderTopColor: c.line }]}>
            {can.rename ? <ActionRow icon={Pencil} title={t("groups.rename")} onPress={() => navigation.navigate("groupCreate", { groupId: group.id })} /> : null}
            {can.delete ? <ActionRow icon={Trash2} danger title={t("groups.delete")} onPress={askDelete} /> : null}
          </View>
        ) : null}
      </ScrollView>
      {picking ? <PeoplePickerModal title={t("groups.addTitle", { group: group.name })} people={pickable} selected={[]} onDone={add} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    scroll: { paddingBottom: 32 },
    note: { paddingHorizontal: 16, paddingVertical: 8 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
    add: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
    section: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    text: { flex: 1, minWidth: 0 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1 },
    more: { padding: 6 },
    reason: { paddingTop: 2 },
    actions: { marginTop: 24, paddingHorizontal: 16, paddingTop: 8, borderTopWidth: shape.hairline },
  }),
);
