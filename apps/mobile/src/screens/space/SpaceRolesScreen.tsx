/**
 * A space's Roles section (mockup frame 4): the roles in rank order, Propriétaire at the top, with
 * their colour, their rights and people, a lock on those at or above the caller's own highest role,
 * and the two base roles apart at the bottom. A role the caller manages opens its editor. Réordonner
 * swaps the chevrons for up and down arrows (no drag: arrows are what a screen reader announces),
 * Terminé saves the new order. The floating button creates a role.
 */
import { refusalOf, type Role, type Workspace } from "@ruchoir/client";
import { holdsEverything, roleRowState, type RoleRowState } from "@ruchoir/client/permissionsLogic";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Clock, Lock, Plus } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { roleColourKey, systemRoleKey, type RoleColour } from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import { moveRole, orderChanged, rowsOf } from "../../logic/roleOrder";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useSession } from "../../session/SessionProvider";
import { useRights, useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { FloatingButton } from "../../ui/FloatingButton";
import { feel } from "../../ui/haptics";
import { RoleDot } from "../../ui/RoleChip";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";

export function SpaceRolesScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("roles");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Roles space={current} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

/** One line of the list, whatever it stands for: a role, the owner, or a base role. */
type Line = {
  id: string;
  label: string;
  colour: RoleColour;
  detail: string;
  state: RoleRowState | "base";
  mine: boolean;
  role?: Role;
};

function Roles({ space }: { space: Workspace }) {
  const { getSpaceMembers, listRoles, orderRoles } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const session = useSession();
  const toast = useToast();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { rights } = useRights();
  const roles = useLoad(`roles:${space.id}`, () => listRoles(space.id));
  const members = useLoad(`members:${space.id}`, (signal) => getSpaceMembers(space.id, signal));
  const [reordering, setReordering] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const { reload: reloadRoles } = roles;
  const { reload: reloadMembers } = members;
  const reloadAll = useCallback(() => {
    reloadRoles();
    reloadMembers();
  }, [reloadRoles, reloadMembers]);
  // The roles changed here or elsewhere, or my own did: the list, the locks and the arrows follow.
  useReloadOn((e) => affects.permissions(e, space.id), reloadAll, 300);

  const frozen = space.edition === "frozen";
  // A community space has its three fixed roles: read, never ordered nor created (the web's own split).
  const canManage = rights.includes("roles.manage") && space.edition === "enterprise";
  const me = session.state.kind === "signedIn" ? session.state.user.id : undefined;
  const mine = members.data?.find((m) => m.userId === me);
  const myTopRoleId = mine?.roleIds?.[0];
  const list = roles.data;
  const ranked = useMemo(() => (list ?? []).filter((r) => r.systemKey !== "members" && r.systemKey !== "guests"), [list]);
  const base = useMemo(() => (list ?? []).filter((r) => r.systemKey === "members" || r.systemKey === "guests"), [list]);
  const rankedIds = useMemo(() => ranked.map((r) => r.id), [ranked]);
  // A draft from before the roles changed under it no longer fits: the server's order wins.
  const order = draft && draft.length === rankedIds.length && draft.every((id) => rankedIds.includes(id)) ? draft : rankedIds;
  const movableCount = ranked.filter((r) => r.manageable).length;
  const mayReorder = canManage && movableCount > 1;
  const owners = members.data ? members.data.filter((m) => m.role === "owner" && !m.bot).length : undefined;

  const label = (role: Role) => {
    const named = systemRoleKey(role);
    return named ? t(SYSTEM_ROLE_LABEL[named]) : role.name;
  };
  const rightsLine = (role: Role) => (holdsEverything(role) ? t("roles.allRights") : t("roles.rightsCount", { count: role.permissions.length }));
  const people = (count: number) => t("conversation.people", { count });

  const lineOf = (role: Role): Line => {
    const isBase = role.systemKey === "members" || role.systemKey === "guests";
    if (isBase) {
      return { id: role.id, label: label(role), colour: "line", detail: role.systemKey === "members" ? t("roles.baseEveryone") : t("roles.baseGuests"), state: "base", mine: false, role };
    }
    return {
      id: role.id,
      label: label(role),
      colour: roleColourKey(role),
      detail: `${rightsLine(role)} · ${people(role.holders)}`,
      state: roleRowState(role, { myTopRoleId, frozen }),
      mine: role.id === myTopRoleId,
      role,
    };
  };

  const done = async () => {
    const wanted = order;
    setReordering(false);
    setDraft(null);
    if (!orderChanged(rankedIds, wanted)) return;
    setSaving(true);
    try {
      await orderRoles(space.id, wanted);
      feel("success");
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      toast(said ? String(t(said.key as never, said.vars as never)) : t("roles.orderFailed"), "failure");
    } finally {
      setSaving(false);
      reloadRoles();
    }
  };

  const move = (id: string, direction: "up" | "down") => {
    feel("choice");
    setDraft(moveRole(ranked, order, id, direction, canManage));
  };

  const owner = space.role === "owner";
  const ownerLine: Line = {
    id: "owner",
    label: t("details.roleOwner"),
    colour: "violet",
    detail: [t("roles.allRights"), owners === undefined ? null : people(owners)].filter(Boolean).join(" · "),
    state: "above",
    mine: owner,
  };
  const rows = rowsOf(ranked, order, canManage && reordering);

  const open = (line: Line) => {
    if (line.state === "edit" && rights.includes("roles.manage")) navigation.navigate("roleEditor", { roleId: line.id });
  };

  const trailing = (line: Line, row?: ReturnType<typeof rowsOf>[number]) => {
    if (reordering && row?.movable) {
      return (
        <View style={styles.arrows}>
          <Arrow direction="up" enabled={row.up && !saving} label={t("roles.moveUp", { role: line.label })} onPress={() => move(line.id, "up")} />
          <Arrow direction="down" enabled={row.down && !saving} label={t("roles.moveDown", { role: line.label })} onPress={() => move(line.id, "down")} />
        </View>
      );
    }
    if (line.state === "edit") return reordering ? null : <ChevronRight size={20} color={c.muted} />;
    if (line.state === "frozen") return <Clock size={18} color={c.muted} />;
    return <Lock size={18} color={c.muted} />;
  };

  const detailOf = (line: Line) => {
    if (!reordering) return line.detail;
    if (line.state === "above") return t("roles.aboveShort");
    if (line.state === "mine") return t("roles.mineShort");
    return line.detail;
  };

  const lineView = (line: Line, row?: ReturnType<typeof rowsOf>[number]) => {
    const opens = !reordering && line.state === "edit" && rights.includes("roles.manage");
    return (
      <Pressable
        key={line.id}
        disabled={!opens}
        onPress={() => open(line)}
        accessibilityRole={opens ? "button" : undefined}
        accessibilityLabel={opens ? line.label : `${line.label}, ${detailOf(line)}`}
        style={({ pressed }) => [styles.row, pressed && opens && { opacity: 0.6 }]}
      >
        <RoleDot colour={line.colour} />
        <View style={styles.text}>
          <View style={styles.nameLine}>
            <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
              {line.label}
            </Text>
            {line.mine ? (
              <View style={[styles.tag, { borderColor: c.lineStrong }]}>
                <Text variant="tiny" tone="muted">
                  {t("roles.yourRoleTag")}
                </Text>
              </View>
            ) : null}
          </View>
          <Text variant="tiny" tone="muted" numberOfLines={2}>
            {detailOf(line)}
          </Text>
        </View>
        {trailing(line, row)}
      </Pressable>
    );
  };

  return (
    <>
      <BackHeader
        title={t("spaceSections.roles")}
        subtitle={reordering ? t("roles.reorder") : space.name}
        trailing={
          mayReorder ? (
            <View style={styles.action}>
              {reordering ? (
                <Button size="sm" variant="primary" label={t("roles.reorderDone")} onPress={() => void done()} />
              ) : (
                <Button size="sm" variant="secondary" label={t("roles.reorder")} icon={<ArrowUpDown size={16} color={c.ink} />} onPress={() => { setDraft(null); setReordering(true); }} busy={saving} />
              )}
            </View>
          ) : undefined
        }
      />
      {!list ? (
        <LoadState error={roles.error} onRetry={reloadRoles} />
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.list}>
            <Text tone="body" style={styles.intro}>
              {reordering ? t("roles.reorderHint") : t("roles.rankedSub")}
            </Text>
            {frozen && !reordering ? (
              <Text variant="small" tone="muted" style={styles.intro}>
                {t("roles.frozenNote")}
              </Text>
            ) : null}
            {lineView(ownerLine)}
            {rows.map((row) => lineView(lineOf(row.role), row))}
            <View style={[styles.separator, { borderColor: c.lineStrong }]}>
              <Text variant="label" tone="muted">
                {t("roles.baseSeparator")}
              </Text>
            </View>
            {base.map((role) => lineView(lineOf(role)))}
          </ScrollView>
          {canManage && !reordering ? <FloatingButton icon={Plus} label={t("roles.new")} onPress={() => navigation.navigate("roleCreate")} /> : null}
        </>
      )}
    </>
  );
}

/** One arrow of Réordonner: disabled (and said so) at the ends of what the caller may move. */
function Arrow({ direction, enabled, label, onPress }: { direction: "up" | "down"; enabled: boolean; label: string; onPress: () => void }) {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const Icon = direction === "up" ? ArrowUp : ArrowDown;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={4}
      onPress={onPress}
      style={[styles.arrow, { borderColor: enabled ? c.ink : c.lineStrong, backgroundColor: c.surface }]}
    >
      <Icon size={18} color={enabled ? c.ink : c.muted} />
    </Pressable>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    list: { paddingBottom: 96 },
    intro: { paddingHorizontal: 16, paddingVertical: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    text: { flex: 1, minWidth: 0 },
    nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { flexShrink: 1 },
    tag: { borderWidth: shape.hairline, borderStyle: "dashed", borderRadius: 9, paddingHorizontal: 6, paddingVertical: 1 },
    arrows: { flexDirection: "row", gap: 8 },
    arrow: { width: 36, height: 36, borderRadius: shape.radius.m, borderWidth: 1, alignItems: "center", justifyContent: "center" },
    separator: { marginTop: 8, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: shape.hairline },
    action: { paddingRight: 8 },
  }),
);
