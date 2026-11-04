/**
 * A role's editor (mockup frame 5): its colour and name in the header, a menu for Voir en tant que and
 * Supprimer, and three tabs. Droits switches the catalogue by family, Personnes lists who holds the
 * role and gives or takes it away, Nom sets the name and the colour. One save bar saves what changed
 * (name, colour, rights) in a single call. A role the caller does not manage, or a frozen space, reads
 * only; the base roles have no name to set and cannot be deleted or previewed.
 */
import { refusalOf, type Group, type Member, type Role } from "@ruchoir/client";
import { rolePeople, usedInRows, type UsedInRow } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Eye, MoreHorizontal, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { roleColourKey, systemRoleKey } from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import { changeCount, editorAccess, editorDraft, familyRows, roleSignature, rolesWith, saveBlock, savePayload, type EditorTab, type RoleDraft } from "../../logic/roleEditor";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { RoleDot } from "../../ui/RoleChip";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { PeoplePickerModal } from "../discussions/PeoplePickerModal";
import { RoleName } from "./RoleName";
import { RolePeople } from "./RolePeople";
import { RoleRights } from "./RoleRights";
import { SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";

export function RoleEditorScreen() {
  const { c } = useTheme();
  const { current } = useSpace();
  useSectionGuard("roles");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Editor spaceId={current.id} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

function Editor({ spaceId }: { spaceId: string }) {
  const { getSpaceMembers, listRoles, listGroups } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "roleEditor">>();
  const navigation = useNavigation();
  const { supported } = useRights();
  const roles = useLoad(`roles:${spaceId}`, () => listRoles(spaceId));
  const members = useLoad(`members:${spaceId}`, (signal) => getSpaceMembers(spaceId, signal));
  const groups = useLoad(supported ? `groups:${spaceId}` : null, () => listGroups(spaceId).catch(() => [] as Group[]));
  const { reload: reloadRoles } = roles;
  const { reload: reloadMembers } = members;
  const { reload: reloadGroups } = groups;
  const reloadAll = useCallback(() => {
    reloadRoles();
    reloadMembers();
    reloadGroups();
  }, [reloadRoles, reloadMembers, reloadGroups]);
  // The roles, their people or the caller's own rights changed here or elsewhere: read them again.
  useReloadOn((e) => affects.permissions(e, spaceId), reloadAll, 300);

  const role = roles.data?.find((r) => r.id === params.roleId);
  // One way out: deleting the role here makes it vanish from the list as well, and each of the two
  // would go back once (leaving the list under it too).
  const leaving = useRef(false);
  const leave = useCallback(() => {
    if (leaving.current || !navigation.canGoBack()) return;
    leaving.current = true;
    navigation.goBack();
  }, [navigation]);
  // A role deleted elsewhere while it was open: nothing left to edit.
  const gone = roles.data !== undefined && !role;
  useEffect(() => {
    if (gone) leave();
  }, [gone, leave]);

  if (!roles.data || !role) {
    return (
      <>
        <BackHeader title="" />
        <LoadState error={roles.error} onRetry={reloadRoles} />
      </>
    );
  }
  return <RoleBody spaceId={spaceId} role={role} roles={roles.data} members={members.data ?? []} groups={groups.data ?? []} onChanged={reloadAll} leave={leave} />;
}

function RoleBody({ spaceId, role, roles, members, groups, onChanged, leave }: { spaceId: string; role: Role; roles: Role[]; members: Member[]; groups: Group[]; onChanged: () => void; leave: () => void }) {
  const { updateRole, deleteRole, startPreview, setMemberRoles } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { current, spaces } = useSpace();
  const { rights } = useRights();
  const [tab, setTab] = useState<EditorTab>("rights");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const [usedIn, setUsedIn] = useState<UsedInRow[] | null>(null);

  // What is saved is the truth: a draft started before the role changed under it starts over.
  const signature = roleSignature(role);
  const [edit, setEdit] = useState<{ base: string; draft: RoleDraft } | null>(null);
  const draft = editorDraft(edit, role);
  const change = (next: RoleDraft) => setEdit({ base: signature, draft: next });

  const frozen = current?.edition === "frozen";
  const access = editorAccess(role, { edition: current?.edition ?? "community", canManageRoles: rights.includes("roles.manage"), frozen });
  const base = role.systemKey === "guests" || role.systemKey === "members";
  const custom = !role.systemKey;
  const tabs = access.tabs;
  const shown: EditorTab = tabs.includes(tab) ? tab : "rights";
  const membersBase = roles.find((r) => r.systemKey === "members")?.permissions ?? [];
  const ranked = useMemo(() => roles.filter((r) => r.systemKey !== "members" && r.systemKey !== "guests"), [roles]);

  const people = rolePeople(role.id, members, groups);
  const direct = role.systemKey === "guests" ? members.filter((m) => m.role === "guest") : base ? [] : people.direct;
  const holderCount = role.systemKey === "guests" ? direct.length : base ? 0 : people.holderIds.length;
  const addable = members.filter((m) => m.manageable && !m.bot && !m.roleIds?.includes(role.id));

  const named = systemRoleKey(role);
  const label = named ? t(SYSTEM_ROLE_LABEL[named]) : role.name;
  const count = changeCount(role, draft);
  const payload = savePayload(role, draft);
  const block = saveBlock(draft);

  const failed = (err: unknown) => {
    const said = refusalSaid(refusalOf(err));
    toast(said ? String(t(said.key as never, said.vars as never)) : t("roles.saveFailed"), "failure");
  };

  const save = async (): Promise<boolean> => {
    if (!payload || count === 0) return false;
    setBusy(true);
    setNameError(undefined);
    try {
      await updateRole(spaceId, role.id, payload);
      feel("success");
      toast(t("roles.saved"), "success");
      // The draft stays: the screen keeps what was saved until the reloaded role arrives, then lets it go.
      onChanged();
      return true;
    } catch (err) {
      const refusal = refusalOf(err);
      const said = refusalSaid(refusal);
      if (said && (refusal?.code === "role_name_taken" || refusal?.code === "role_name_reserved")) {
        setNameError(String(t(said.key as never, said.vars as never)));
        setTab("name");
      } else failed(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteRole(spaceId, role.id);
      feel("success");
      toast(t("roles.deleted"), "success");
      onChanged();
      leave();
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal?.code === "role_has_rules" && refusal.usedIn) {
        // Where the rules name it, so they can be lifted first.
        setUsedIn(usedInRows(refusal.usedIn));
        setTab("name");
        feel("warning");
      } else failed(err);
    } finally {
      setBusy(false);
    }
  };

  const askDelete = () =>
    Alert.alert(t("roles.deleteTitle", { role: role.name }), t("roles.deleteBody"), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("roles.delete"), style: "destructive", onPress: () => void remove() },
    ]);

  const viewAs = async () => {
    setBusy(true);
    try {
      await startPreview(spaceId, role.id);
      // The space now comes back as this role: the banner appears and the app starts again under it.
      spaces.reload();
      leave();
    } catch (err) {
      const refusal = refusalOf(err);
      const known = refusal?.code === "base_role_not_previewable" ? t("preview.refusal.baseRole") : refusal?.code === "preview_unavailable" ? t("preview.refusal.unavailable") : null;
      toast(known ?? t("preview.startFailed"), "failure");
    } finally {
      setBusy(false);
    }
  };

  // The preview starts the app's navigation again, so what is typed here would be lost: ask first.
  const askViewAs = () => {
    if (count === 0) return void viewAs();
    Alert.alert(t("roles.unsavedTitle"), t("roles.unsavedBody"), [
      ...(block ? [] : [{ text: t("compose.save"), onPress: () => void save().then((saved) => (saved ? viewAs() : undefined)) }]),
      {
        text: t("eventForm.discard"),
        style: "destructive" as const,
        onPress: () => {
          setEdit(null);
          void viewAs();
        },
      },
      { text: t("compose.cancel"), style: "cancel" as const },
    ]);
  };

  const menu = () =>
    Alert.alert(label, undefined, [
      ...(access.canPreview ? [{ text: t("preview.viewAs"), onPress: askViewAs }] : []),
      ...(access.canDelete ? [{ text: t("roles.delete"), style: "destructive" as const, onPress: askDelete }] : []),
      { text: t("compose.cancel"), style: "cancel" as const },
    ]);

  const give = async (ids: string[]) => {
    setPicking(false);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const id of ids) {
        const member = members.find((m) => m.userId === id);
        if (member) await setMemberRoles(spaceId, id, rolesWith(member.roleIds, ranked, role.id, true));
      }
      feel("success");
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const takeAway = async (member: Member) => {
    setBusy(true);
    try {
      await setMemberRoles(spaceId, member.userId, rolesWith(member.roleIds, ranked, role.id, false));
      feel("success");
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const toggle = (permission: string, on: boolean) => {
    const permissions = new Set(draft.permissions);
    if (on) permissions.add(permission);
    else permissions.delete(permission);
    change({ ...draft, permissions });
  };

  const subtitle = role.systemKey === "members" ? t("roles.baseEveryone") : role.systemKey === "guests" ? t("roles.baseGuests") : t("conversation.people", { count: holderCount });
  const tabLabel: Record<EditorTab, string> = { rights: t("roles.tabRights"), people: t("discussions.filterPeople"), name: t("files.name") };
  const showFooter = count > 0 || block !== null || access.canPreview || access.canDelete;

  return (
    <View style={styles.fill}>
      <BackHeader
        title={label}
        subtitle={subtitle}
        leading={<RoleDot colour={role.systemKey === "administrator" ? "peach" : roleColourKey({ colour: draft.colour, systemKey: role.systemKey })} size={36} />}
        trailing={
          access.canPreview || access.canDelete ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("roles.more")} hitSlop={8} onPress={menu} style={styles.more}>
              <MoreHorizontal size={22} color={c.ink} />
            </Pressable>
          ) : undefined
        }
      />
      {tabs.length > 1 ? (
        <Segmented style={styles.tabs} options={tabs.map((key) => ({ key, label: tabLabel[key] }))} value={shown} onChange={setTab} />
      ) : null}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {frozen ? (
          <Text variant="small" tone="muted" style={styles.frozen}>
            {t("roles.frozenNote")}
          </Text>
        ) : null}
        {shown === "rights" ? (
          <RoleRights
            families={familyRows(role, draft, { viewerRights: rights, membersBase })}
            guests={role.systemKey === "guests"}
            editable={access.editable && !busy}
            onToggle={toggle}
          />
        ) : null}
        {shown === "people" ? (
          <RolePeople
            roleName={label}
            guests={role.systemKey === "guests"}
            direct={direct}
            viaGroups={base ? [] : people.viaGroups}
            editable={access.editable && !busy}
            canAdd={access.editable && role.systemKey !== "guests" && addable.length > 0}
            onAdd={() => setPicking(true)}
            onTakeAway={(member) => void takeAway(member)}
          />
        ) : null}
        {shown === "name" && custom ? (
          <RoleName
            name={draft.name}
            colour={draft.colour}
            editable={access.editable && !busy}
            error={nameError ?? (block ? t("roles.nameRequired") : undefined)}
            usedIn={usedIn}
            roleName={role.name}
            onName={(name) => {
              setNameError(undefined);
              change({ ...draft, name });
            }}
            onColour={(colour) => change({ ...draft, colour })}
          />
        ) : null}
      </ScrollView>
      {showFooter ? (
        <View style={[styles.footer, { borderTopColor: c.line, backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {count > 0 || block ? (
            <View style={styles.bar}>
              <Text variant="bodyStrong" style={styles.barText} tone={block ? "danger" : undefined}>
                {block ? t("roles.nameRequired") : t("roles.changes", { count })}
              </Text>
              <Button size="md" label={t("compose.save")} busy={busy} disabled={!payload || block !== null || count === 0} onPress={() => void save()} />
            </View>
          ) : null}
          {access.canPreview || access.canDelete ? (
            <View style={styles.actions}>
              {access.canPreview ? <Button size="md" variant="secondary" label={t("preview.viewAs")} icon={<Eye size={16} color={c.ink} />} disabled={busy} onPress={askViewAs} style={styles.action} /> : null}
              {access.canDelete ? <Button size="md" variant="danger" label={t("roles.delete")} icon={<Trash2 size={16} color={c.onInk} />} disabled={busy} onPress={askDelete} style={styles.action} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {picking ? <PeoplePickerModal title={t("roles.addPerson")} people={addable} selected={[]} onDone={(ids) => void give(ids)} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    more: { padding: 8 },
    tabs: { marginHorizontal: 16, marginBottom: 4 },
    scroll: { paddingBottom: 24 },
    frozen: { paddingHorizontal: 16, paddingVertical: 8 },
    footer: { borderTopWidth: shape.hairline, paddingHorizontal: 16, paddingTop: 12, gap: 10 },
    bar: { flexDirection: "row", alignItems: "center", gap: 12 },
    barText: { flex: 1 },
    actions: { flexDirection: "row", gap: 10 },
    action: { flex: 1 },
  }),
);
