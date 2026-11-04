/**
 * Who has access to a channel, a file or folder, or a calendar, and at what level (mockups 9 and 11):
 * the base line (Tout l'espace), then the lines in the web's order with an override in place, a level
 * button on each that opens a sheet of the levels, "Pourquoi ?" on a person, and Ajouter. A channel
 * also says whether it is public or private. What the caller may do comes from the API's `may` block:
 * this offers that and says why the rest is off, it never decides. Every refusal is said in the web's
 * sentence.
 */
import { refusalOf, type AccessEntry, type AccessView } from "@ruchoir/client";
import { askWho, delegationIntro, freeManage, levelLabelKey, readOnlyReason } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Info, Lock, Plus, SlidersHorizontal, UserCheck } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useSharedT } from "../../i18n/sharedT";
import { communityLock, entryLine, entryRows, levelGlossary, privateNoteFor, subtitleOf, titleOf } from "../../logic/accessScreen";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { Segmented } from "../../ui/Segmented";
import { LoadState } from "../../ui/States";
import { SheetHeader } from "../../ui/SheetHeader";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { EntryTile, LevelButton, useEntryName } from "./AccessParts";
import { VerifyPicker } from "./VerifyPicker";
import { useAccess, useAccessNames } from "./useAccess";

export function AccessScreen() {
  const { c } = useTheme();
  const { params } = useRoute<RouteProp<RootParams, "access">>();
  const navigation = useNavigation();
  const say = useSharedT();
  const title = titleOf(params.kind, params.folder === true, params.title);
  const { spaceId, view, error, reload } = useAccess(params.kind, params.resourceId, { toastWhenGone: true });
  const sub = subtitleOf(params.kind, params.folder === true, view ?? null, useViewerId());
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={say(title.key, title.vars)} subtitle={view ? say(sub.key, sub.vars) : undefined} onClose={() => navigation.goBack()} />
      {!view || !spaceId ? <LoadState error={error} onRetry={reload} /> : <Body spaceId={spaceId} view={view} reload={reload} />}
    </SafeAreaView>
  );
}

function useViewerId(): string | undefined {
  const { state } = useSession();
  return state.kind === "signedIn" ? state.user.id : undefined;
}

function Body({ spaceId, view, reload }: { spaceId: string; view: AccessView; reload: () => void }) {
  const { params } = useRoute<RouteProp<RootParams, "access">>();
  const { kind, resourceId, folder = false } = params;
  const { updateChannel, getAccess, removeAccessEntry, getInstanceCapabilities } = useApi();
  const { t } = useTranslation();
  const say = useSharedT();
  const { locale } = useLocale();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const { emit } = useRealtimeActions();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const viewerId = useViewerId();
  const names = useAccessNames(spaceId);
  const nameOf = useEntryName();
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  // Who was just added from the add screen (it hands them back through the route), for the private channel's note.
  const [added, setAdded] = useState<{ key: string; name: string }[]>([]);
  const justAdded = params.added;
  const [seenAdded, setSeenAdded] = useState(justAdded);
  if (justAdded !== seenAdded) {
    setSeenAdded(justAdded);
    if (justAdded?.length) setAdded((prev) => [...prev, ...justAdded]);
  }

  // For a file or folder: what the folder above lists, which is what this item would inherit.
  const parentId = kind === "file" && view.resource.parent && !view.resource.parent.hidden ? view.resource.parent.id : undefined;
  const parent = useLoad(parentId ? `access:${spaceId}:file:${parentId}` : null, () => getAccess(spaceId, "file", parentId!).catch(() => undefined));
  useReloadOn((e) => !!parentId && affects.access(e, "file", spaceId, parentId), parent.reload, 300);
  const caps = useLoad("capabilities", (signal) => getInstanceCapabilities(signal));
  const pricingUrl = caps.data?.pricingUrl;

  const rows = useMemo(() => entryRows(view.entries, parent.data ? { entries: parent.data.entries, name: view.resource.parent?.name } : undefined), [view, parent.data]);
  const editable = view.may.edit && !view.archived;
  const adminRoleIds = useMemo(() => new Set(names.roles.filter((r) => r.systemKey === "administrator").map((r) => r.id)), [names.roles]);
  const lock = communityLock(kind, view, view.entries, adminRoleIds);
  const free = freeManage(view, kind, folder);
  const list = (items: string[]) => new Intl.ListFormat(locale, { style: "long", type: "disjunction" }).format(items);
  const who = (() => {
    const asked = askWho(names.members);
    return asked.length === 0 ? t("access.freeManage.noNames") : list(asked);
  })();
  const shownName = kind === "channel" ? `#${params.title}` : params.title;
  const firstOverride = rows.find((r) => r.override);
  const note = privateNoteFor(view, added);
  const glossary = levelGlossary(kind);

  /** One write; whatever happens, the screen reads the access again, and the rest of the app is told. */
  const run = async (write: () => Promise<unknown>, tell?: "channels") => {
    setBusy(true);
    try {
      await write();
      feel("success");
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      toast(said ? String(t(said.key as never, said.vars as never)) : t("compose.editFailed"), "failure");
    } finally {
      setBusy(false);
      reload();
      emit({ type: "permissions", spaceId });
      if (tell === "channels") emit({ type: "channels", spaceId, channelId: resourceId });
    }
  };

  const setType = (next: "public" | "private") => {
    if (!editable || busy || next === (view.private ? "private" : "public")) return;
    void run(() => updateChannel(resourceId, { type: next }), "channels");
  };

  const openLevel = (entry: AccessEntry) =>
    navigation.navigate("accessLevel", { kind, resourceId, target: { kind: entry.target.kind, id: entry.target.id }, title: params.title, folder });

  const restore = (entry: AccessEntry) => {
    if (entry.id) void run(() => removeAccessEntry(spaceId, kind, resourceId, entry.id!));
  };

  const free2 = free ? { lead: say(free.lead), detail: say(free.detail, { name: shownName, who }), cta: say(free.cta) } : undefined;
  const readOnlyKey = !editable && !free ? readOnlyReason(view, kind) : undefined;
  const delegated = delegationIntro(view, viewerId, kind, folder) !== undefined;

  const learn = useCallback(() => {
    if (pricingUrl) void Linking.openURL(pricingUrl).catch(() => {});
  }, [pricingUrl]);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {free2 ? (
        <Box tone="warning" icon={<Lock size={15} color={c.onPastel} />}>
          <Text variant="small" tone="onPastel">
            <Text variant="smallStrong" tone="onPastel">
              {free2.lead}
            </Text>{" "}
            {free2.detail}
          </Text>
        </Box>
      ) : readOnlyKey ? (
        <Box tone="plain">
          <Text variant="small" tone="body">
            {say(readOnlyKey)}
          </Text>
        </Box>
      ) : null}
      {delegated ? (
        <Box tone="plain" icon={<UserCheck size={15} color={c.ink} />}>
          <Text variant="small" tone="body">
            <Text variant="smallStrong">{t("access.delegationHead", { name: shownName })}</Text> {t("access.delegationBody")}
          </Text>
        </Box>
      ) : null}

      {kind === "channel" ? (
        <View style={styles.type}>
          <View pointerEvents={editable && !busy ? "auto" : "none"} style={!editable ? styles.dim : undefined} accessibilityLabel={t("access.typeLabel")}>
            <Segmented
              options={[
                { key: "public", label: t("access.publicTitle") },
                { key: "private", label: t("access.privateTitle") },
              ]}
              value={view.private ? "private" : "public"}
              onChange={setType}
            />
          </View>
          <Text variant="small" tone="body" style={styles.pad}>
            {view.private ? t("access.privateBody") : t("access.publicBody")}
          </Text>
        </View>
      ) : null}

      <Text variant="label" tone="muted" style={[styles.pad, styles.head]}>
        {t("access.colWho")}
      </Text>
      {rows.map(({ entry, override }) => {
        const name = nameOf(entry, names);
        const member = entry.target.kind === "user" ? names.members.find((m) => m.userId === entry.target.id) : undefined;
        const group = entry.target.kind === "group" ? names.groups.find((g) => g.id === entry.target.id) : undefined;
        const role = entry.target.kind === "role" ? names.roles.find((r) => r.id === entry.target.id) : undefined;
        const line = entryLine(say, entry, view.entries, { viewerId, kind, title: member?.title, people: group?.memberIds.length, customRole: !!role && !role.systemKey, override }).join(" · ");
        const selectable = editable && !busy && !entry.inheritedFrom;
        const from = entry.inheritedFrom && !entry.inheritedFrom.hidden && entry.inheritedFrom.id ? { id: entry.inheritedFrom.id, name: entry.inheritedFrom.name ?? "" } : undefined;
        const levelWord = say(levelLabelKey(kind, entry.level));
        const body = (
          <>
            <EntryTile entry={entry} names={names} />
            <View style={styles.text}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {name}
              </Text>
              {line ? (
                <Text variant="tiny" tone="muted" numberOfLines={3}>
                  {line}
                </Text>
              ) : null}
              {entry.target.kind === "user" && entry.target.id ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t("access.whyLink")} ${name}`}
                  hitSlop={8}
                  onPress={() => navigation.navigate("why", { kind, resourceId, userId: entry.target.id!, title: params.title, folder })}
                  style={styles.why}
                >
                  <Info size={13} color={s.link} />
                  <Text variant="smallStrong" style={{ color: s.link }}>
                    {t("access.whyLink")}
                  </Text>
                </Pressable>
              ) : null}
              {override && editable && entry.id ? (
                <Pressable accessibilityRole="button" hitSlop={8} disabled={busy} onPress={() => restore(entry)} style={styles.why}>
                  <Text variant="smallStrong" style={{ color: s.link }}>
                    {t("access.restore")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <LevelButton
              label={levelWord}
              accessibilityLabel={t("access.levelFor", { name })}
              locked={!!entry.inheritedFrom || !editable}
              onPress={selectable ? () => openLevel(entry) : undefined}
            />
          </>
        );
        const key = entry.id ?? `${entry.target.kind}:${entry.target.id ?? ""}:${entry.inheritedFrom?.id ?? ""}`;
        return from ? (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityHint={from.name}
            onPress={() => navigation.push("access", { kind: "file", resourceId: from.id, title: from.name, folder: true })}
            style={[styles.row, styles.inherited]}
          >
            {body}
          </Pressable>
        ) : (
          <View key={key} style={styles.row}>
            {body}
          </View>
        );
      })}

      {editable ? (
        <View style={styles.pad}>
          <ActionRow icon={Plus} tint={c.pink} title={t("access.add")} onPress={() => navigation.navigate("accessAdd", { kind, resourceId, title: params.title, folder })} />
        </View>
      ) : null}

      {lock ? (
        <View style={[styles.pad, styles.dim]}>
          <ActionRow
            icon={SlidersHorizontal}
            title={t("customise.openFor", { name: nameOf(lock, names) })}
            subtitle={t("customise.upsell")}
          />
        </View>
      ) : null}

      <View style={styles.glossary}>
        <Info size={14} color={c.muted} style={styles.glossaryIcon} />
        <Text variant="small" tone="muted" style={styles.boxText}>
          {delegated
            ? t("access.delegationFoot")
            : glossary.map((g, i) => (
                <Text key={g.label} variant="small" tone="muted">
                  <Text variant="smallStrong" tone="body">
                    {say(g.label)}
                  </Text>{" "}
                  {say(g.desc)}
                  {i < glossary.length - 1 ? " " : ""}
                </Text>
              ))}
        </Text>
      </View>

      {firstOverride?.override ? (
        <Box tone="plain" icon={<Info size={15} color={c.ink} />}>
          <Text variant="small" tone="body">
            <Text variant="smallStrong">{t("access.closestWins")}</Text>{" "}
            {t("access.closestWinsBody", {
              name: firstOverride.entry.target.name ?? t("access.hiddenTarget"),
              level: say(levelLabelKey(kind, firstOverride.entry.level)),
              parentLevel: say(levelLabelKey(kind, firstOverride.override.level)),
            })}
          </Text>
        </Box>
      ) : null}

      {note ? (
        <Box tone="plain" icon={<Info size={15} color={c.ink} />}>
          <Text variant="small" tone="body">
            {t("access.privateNote", { count: note.names.length, names: list(note.names), channel: shownName })}
          </Text>
        </Box>
      ) : null}

      <Box tone="dashed" icon={<UserCheck size={16} color={c.muted} />}>
        <Text variant="small" tone="body">
          <Text variant="smallStrong">{t("access.verifyTitle")}</Text> {t("access.verifyBody")}
        </Text>
        <Button label={t("access.verify")} variant="secondary" onPress={() => setVerifying(true)} style={styles.verify} />
      </Box>

      {!view.may.fine && pricingUrl ? (
        <Box tone="dashed" icon={<Lock size={16} color={c.muted} />}>
          <Text variant="small" tone="body">
            {free2 ? free2.cta : t("access.teaser")}{" "}
            <Text variant="smallStrong" tone="link" accessibilityRole="link" onPress={learn}>
              {t("access.learnMore")}
            </Text>
          </Text>
        </Box>
      ) : null}
      {verifying ? (
        <VerifyPicker
          people={names.members}
          onClose={() => setVerifying(false)}
          onPick={(member) => {
            setVerifying(false);
            navigation.navigate("why", { kind, resourceId, userId: member.userId, title: params.title, folder });
          }}
        />
      ) : null}
    </ScrollView>
  );
}

/** A note in a box: a warning (the pastel), a plain one, or the dashed card of an edition lock. */
function Box({ tone, icon, children }: { tone: "warning" | "plain" | "dashed"; icon?: React.ReactNode; children: React.ReactNode }) {
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const look = tone === "warning" ? { backgroundColor: c.sun, borderColor: s.edge } : tone === "plain" ? { backgroundColor: s.sunken, borderColor: c.line } : { borderColor: c.lineStrong, borderStyle: "dashed" as const };
  return (
    <View style={[styles.box, look]}>
      {icon ? <View style={styles.boxIcon}>{icon}</View> : null}
      <View style={styles.boxText}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    scroll: { paddingBottom: 40, gap: 4 },
    pad: { paddingHorizontal: 16 },
    head: { paddingTop: 14, paddingBottom: 2 },
    type: { gap: 8, paddingBottom: 4 },
    dim: { opacity: 0.55 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
    inherited: { opacity: 0.8 },
    text: { flex: 1, minWidth: 0, gap: 1 },
    why: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 4, alignSelf: "flex-start" },
    box: { flexDirection: "row", gap: 8, marginHorizontal: 16, marginVertical: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: shape.radius.m, borderWidth: shape.hairline },
    boxIcon: { paddingTop: 2 },
    boxText: { flex: 1, minWidth: 0 },
    glossary: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 10 },
    glossaryIcon: { marginTop: 2 },
    verify: { marginTop: 8, alignSelf: "flex-start" },
  }),
);
