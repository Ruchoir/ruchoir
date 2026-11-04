/**
 * Put people, groups and roles on a resource's list at one level (the web's "Ajouter à ..."): a
 * search, a tick for each, one level for the whole selection. The guest ceiling is said where it
 * bites (Gérer is not offered when a guest is picked; a group holding guests warns that its guests
 * get less). A custom role as a target is the paid edition's, the Administrator role is free to name.
 * What went through stays; the screen stays open on what did not.
 */
import { refusalOf, type AccessLevel, type AccessTargetRef } from "@ruchoir/client";
import { foldName } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, SearchX, Shield, TriangleAlert } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { useSharedT } from "../../i18n/sharedT";
import { addRows, viaAsks, viaNote } from "../../logic/accessScreen";
import { roleColourKey } from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { SearchField } from "../../ui/SearchField";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { GroupTile, useRoleLabel } from "../space/GroupParts";
import { useAccess, useAccessNames } from "./useAccess";

type Pick = { ref: AccessTargetRef & { kind: "user" | "group" | "role" }; name: string; guest: boolean };
type Item =
  | { type: "head"; key: string; label: string }
  | { type: "row"; key: string; pick: Pick; lead: React.ReactNode; sub?: string; via?: string };

export function AddTargetScreen() {
  const { params } = useRoute<RouteProp<RootParams, "accessAdd">>();
  const { kind, resourceId, title } = params;
  const { setAccessLevel, explainAccess } = useApi();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const say = useSharedT();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const { emit } = useRealtimeActions();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const roleLabel = useRoleLabel();
  const { spaceId, view, error, reload } = useAccess(kind, resourceId, { toastWhenGone: true });
  const { members, groups, roles } = useAccessNames(spaceId);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, Pick>>(() => new Map());
  const [level, setLevel] = useState<Exclude<AccessLevel, "custom" | "none">>("read");
  const [busy, setBusy] = useState(false);

  const shownName = kind === "channel" ? `#${title}` : title;
  const listed = useMemo(() => new Set((view?.entries ?? []).filter((e) => !e.inheritedFrom).map((e) => `${e.target.kind}:${e.target.id ?? ""}`)), [view]);
  const needle = foldName(query.trim());
  const guestIds = useMemo(() => new Set(members.filter((m) => m.role === "guest").map((m) => m.userId)), [members]);

  // Under a person who already reaches the item through a group or a role, say which. Only for a short
  // list: each person is one explanation.
  const [via, setVia] = useState<Record<string, string | null>>({});
  const askFor = viaAsks(members.filter((m) => !m.bot && m.userId !== me && foldName(m.name).includes(needle)));
  const askKey = askFor.join(",");
  useEffect(() => {
    if (!spaceId) return;
    let active = true;
    for (const userId of askKey ? askKey.split(",") : []) {
      if (via[userId] !== undefined) continue;
      explainAccess(spaceId, kind, resourceId, userId).then(
        (why) => active && setVia((prev) => ({ ...prev, [userId]: viaNote(why, kind) ?? null })),
        () => active && setVia((prev) => ({ ...prev, [userId]: null })),
      );
    }
    return () => {
      active = false;
    };
    // `via` is read to skip what is known; asking again on each answer would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, spaceId, kind, resourceId, explainAccess]);

  const items = useMemo((): Item[] => {
    if (!view) return [];
    const out: Item[] = [];
    const shownGroups = groups.filter((g) => foldName(g.name).includes(needle));
    // The Administrator role is free to name; a custom role as a target is the paid edition's.
    const shownRoles = roles.filter((r) => r.systemKey === "administrator" || (!r.systemKey && view.may.fine)).filter((r) => foldName(roleLabel(r)).includes(needle));
    const people = members.filter((m) => !m.bot && m.userId !== me && foldName(m.name).includes(needle));
    if (shownGroups.length > 0) {
      out.push({ type: "head", key: "h-groups", label: t("spaceSections.groups") });
      for (const g of shownGroups) out.push({ type: "row", key: `group:${g.id}`, pick: { ref: { kind: "group", id: g.id }, name: g.name, guest: false }, lead: <GroupTile id={g.id} />, sub: t("compose.groupLine", { count: g.memberIds.length }) });
    }
    if (shownRoles.length > 0) {
      out.push({ type: "head", key: "h-roles", label: t("spaceSections.roles") });
      for (const r of shownRoles) {
        const name = roleLabel(r);
        out.push({ type: "row", key: `role:${r.id}`, pick: { ref: { kind: "role", id: r.id }, name, guest: false }, lead: <RoleTile colour={c[roleColourKey(r)]} />, sub: r.systemKey ? t("spaceAdmin.role") : t("access.customRoleSub") });
      }
    }
    if (people.length > 0) {
      out.push({ type: "head", key: "h-people", label: t("discussions.filterPeople") });
      for (const m of people) {
        const guest = m.role === "guest";
        out.push({ type: "row", key: `user:${m.userId}`, pick: { ref: { kind: "user", id: m.userId }, name: m.name, guest }, lead: <Avatar name={m.name} src={m.avatarUrl} size={40} />, sub: [guest ? t("invite.guest") : undefined, m.title].filter(Boolean).join(" · "), via: via[m.userId] ? t("why.alreadyVia", { via: via[m.userId]! }) : undefined });
      }
    }
    return out;
  }, [view, groups, roles, members, needle, me, roleLabel, t, c, via]);

  if (!view || !spaceId) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.surface }]}>
        <SheetHeader title={t("access.addTitle", { name: shownName })} onClose={() => navigation.goBack()} />
        <LoadState error={error} onRetry={reload} />
      </SafeAreaView>
    );
  }

  const chosen = [...picked.values()];
  const rows = addRows(kind, view.may, chosen.map((p) => ({ kind: p.ref.kind, guest: p.guest })));
  const open = rows.filter((r) => !r.disabled);
  const effective = open.find((r) => r.id === level) ? level : ((open[0]?.id ?? level) as typeof level);
  const guestPerson = chosen.find((p) => p.ref.kind === "user" && p.guest);
  const guestGroups = chosen.filter((p) => p.ref.kind === "group" && groups.find((g) => g.id === p.ref.id)?.memberIds.some((id) => guestIds.has(id)));
  const current = rows.find((r) => r.id === effective);

  const toggle = (key: string, pick: Pick) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, pick);
      return next;
    });

  const add = async () => {
    setBusy(true);
    const done: string[] = [];
    try {
      for (const [key, p] of picked) {
        await setAccessLevel(spaceId, kind, resourceId, { kind: p.ref.kind, id: p.ref.id }, effective);
        done.push(key);
      }
      feel("success");
      emit({ type: "permissions", spaceId });
      // Back on the access screen, which says (for a private channel) who now sees it.
      navigation.popTo("access", { kind, resourceId, title, folder: params.folder, added: [...picked.entries()].map(([key, p]) => ({ key, name: p.name })) });
    } catch (err) {
      // What went through stays; the screen stays open on what did not.
      if (done.length > 0) emit({ type: "permissions", spaceId });
      const said = refusalSaid(refusalOf(err));
      toast(said ? String(t(said.key as never, said.vars as never)) : t("compose.editFailed"), "failure");
      setPicked((prev) => {
        const next = new Map(prev);
        for (const key of done) next.delete(key);
        return next;
      });
      setBusy(false);
    }
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("access.addTitle", { name: shownName })} subtitle={t("access.addSub")} onClose={() => navigation.goBack()} />
      <View style={styles.search}>
        <SearchField value={query} onChange={setQuery} placeholder={t("access.search")} />
      </View>
      <KeyboardArea style={styles.fill} safeBottom>
        <FlatList
          style={styles.fill}
          data={items}
          extraData={picked}
          keyExtractor={(item) => item.key}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          ListEmptyComponent={<EmptyState size="compact" icon={SearchX} title={t("people.none")} />}
          renderItem={({ item }) => {
            if (item.type === "head") {
              return (
                <Text variant="label" tone="muted" style={styles.head}>
                  {item.label}
                </Text>
              );
            }
            const already = listed.has(item.key);
            const on = already || picked.has(item.key);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: already || busy }}
                disabled={already || busy}
                onPress={() => toggle(item.key, item.pick)}
                style={[styles.row, already && styles.listed]}
              >
                {item.lead}
                <View style={styles.text}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {item.pick.name}
                  </Text>
                  {already || item.sub ? (
                    <Text variant="tiny" tone="muted" numberOfLines={1}>
                      {already ? t("access.alreadyListed") : item.sub}
                    </Text>
                  ) : null}
                  {item.via && !already ? (
                    <Text variant="tiny" tone="muted" numberOfLines={2}>
                      {item.via}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.box, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>{on ? <Check size={16} color={c.onInk} /> : null}</View>
              </Pressable>
            );
          }}
        />
        <View style={[styles.foot, { borderTopColor: c.line }]}>
          {chosen.length > 0 ? (
            <>
              <Text variant="label" tone="muted">
                {t("access.levelForSelected", { count: chosen.length })}
              </Text>
              <Segmented
                style={styles.flush}
                options={open.map((r) => ({ key: r.id as "read" | "contribute" | "manage", label: say(r.titleKey) }))}
                value={effective}
                onChange={(next) => setLevel(next)}
              />
              <Text variant="tiny" tone="muted">
                {current?.descKey ? say(current.descKey) : ""}
                {rows.some((r) => r.disabled && r.reasonKey) ? ` ${say("access.guestCap")}` : ""}
              </Text>
              {guestPerson || guestGroups.length > 0 ? (
                <View style={[styles.warn, { backgroundColor: c.sun }]}>
                  <TriangleAlert size={15} color={c.onPastel} />
                  <Text variant="tiny" tone="onPastel" style={styles.text}>
                    {[guestPerson ? t("access.guestNotice", { name: guestPerson.name }) : "", guestGroups.length > 0 ? t("access.guestGroupNotice", { count: guestGroups.length }) : ""].filter(Boolean).join(" ")}
                  </Text>
                </View>
              ) : null}
            </>
          ) : null}
          <Button
            label={chosen.length === 0 ? t("group.addExternal") : t("access.addConfirm", { count: chosen.length })}
            onPress={() => void add()}
            busy={busy}
            disabled={chosen.length === 0 || open.length === 0}
          />
        </View>
      </KeyboardArea>
    </SafeAreaView>
  );
}

/** A role's square: the shield on its colour. */
function RoleTile({ colour }: { colour: string }) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.tile, { backgroundColor: colour, borderColor: s.edge }]}>
      <Shield size={20} color={c.onPastel} />
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    search: { paddingBottom: 8 },
    head: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 8, minHeight: 56 },
    listed: { opacity: 0.6 },
    text: { flex: 1, minWidth: 0 },
    box: { width: 24, height: 24, borderRadius: shape.radius.s, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    tile: { width: 40, height: 40, borderRadius: shape.radius.m, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    foot: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 8, borderTopWidth: shape.hairline },
    flush: { marginHorizontal: 0 },
    warn: { flexDirection: "row", gap: 8, padding: 10, borderRadius: shape.radius.m, alignItems: "flex-start" },
  }),
);
