/**
 * A space's Journal (mockup frame 12), read only: every change of rights, newest first, grouped by
 * the reader's day, filed under the category pastilles. Each line is the shared `auditLine` drawn as
 * text with the names in bold, the actor's avatar and the time; Voir plus loads the next page. A
 * live change merges the fresh first page into what is loaded (nothing jumps), a pull starts over.
 * The list is virtualised (a day is a section). A community space says it keeps thirty days.
 */
import type { AuditEntry, Role } from "@ruchoir/client";
import { auditLine, AUDIT_CATEGORIES, levelLabelKey, PERMISSION_TEXT, type AuditCategory, type Kind, type Level } from "@ruchoir/client/permissionsLogic";
import { FileText, Info } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { chipsOf, fillFor, groupEntriesByDay, lineRuns, mergeFirstPage, mergePages, type ChipWords, type Words } from "../../logic/auditRender";
import { dayKey, timeOf } from "../../logic/format";
import { systemRoleKey } from "../../logic/memberScreen";
import { affects } from "../../realtime/events";
import { useSectionGuard } from "../../space/rights";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Avatar } from "../../ui/Avatar";
import { BackHeader } from "../../ui/BackHeader";
import { Button } from "../../ui/Button";
import { type Chip, Chips } from "../../ui/Chips";
import { feel } from "../../ui/haptics";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useDayLabel } from "../agenda/DayEvents";
import { SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";

const PAGE = 50;

/** Each family's label: the words the phone already has for it. */
const CATEGORY_LABEL = {
  members: key("details.members"),
  roles: key("spaceSections.roles"),
  groups: key("spaceSections.groups"),
  channels: key("tabs.channels"),
  calendars: key("calendar.calendars"),
  licence: key("spaceSections.licence"),
  guests: key("guests.sectionTitle"),
  access: key("access.tab"),
} as const satisfies Record<AuditCategory, string>;

/** A base role of an older line. */
const LEGACY_LABEL = { owner: key("details.roleOwner"), admin: key("role.admin"), member: key("invite.member"), guest: key("invite.guest") } as const;

const RESOURCE_WORD = { channel: key("audit.onChannel"), file: key("audit.onFile"), calendar: key("audit.onCalendar") } as const;
const RESOURCE_UNNAMED = { channel: key("audit.onUnnamedChannel"), file: key("audit.onUnnamedFile"), calendar: key("audit.onUnnamedCalendar") } as const;

/** Every sentence's dictionary key. Plural ones (`licenceInstalled`, `groupDeleted`...) take `count`. */
const SENTENCE = {
  memberJoined: key("audit.memberJoined"),
  memberJoinedGuest: key("audit.memberJoinedGuest"),
  memberLeft: key("audit.memberLeft"),
  memberRemoved: key("audit.memberRemoved"),
  memberRoleChanged: key("audit.memberRoleChanged"),
  ownershipTransferred: key("audit.ownershipTransferred"),
  memberRolesChanged: key("audit.memberRolesChanged"),
  roleCreated: key("audit.roleCreated"),
  roleUpdated: key("audit.roleUpdated"),
  roleRenamed: key("audit.roleRenamed"),
  roleDeleted: key("audit.roleDeleted"),
  rolesReordered: key("audit.rolesReordered"),
  channelReserved: key("audit.channelReserved"),
  channelOpened: key("audit.channelOpened"),
  calendarWriteMembers: key("audit.calendarWriteMembers"),
  calendarWriteAdmins: key("audit.calendarWriteAdmins"),
  groupCreated: key("audit.groupCreated"),
  groupRenamed: key("audit.groupRenamed"),
  groupDescribed: key("audit.groupDescribed"),
  groupDeleted: key("audit.groupDeleted"),
  groupDeletedBare: key("audit.groupDeletedBare"),
  groupMembersAdded: key("audit.groupMembersAdded"),
  groupMembersRemoved: key("audit.groupMembersRemoved"),
  groupRolesChanged: key("audit.groupRolesChanged"),
  groupManagersAdded: key("audit.groupManagersAdded"),
  groupManagersRemoved: key("audit.groupManagersRemoved"),
  groupManagersChanged: key("audit.groupManagersChanged"),
  ruleCreated: key("audit.ruleCreated"),
  ruleUpdated: key("audit.ruleUpdated"),
  ruleCustomised: key("audit.ruleCustomised"),
  ruleDeleted: key("audit.ruleDeleted"),
  ruleReserved: key("audit.ruleReserved"),
  rolePreviewStarted: key("audit.rolePreviewStarted"),
  rolePreviewEnded: key("audit.rolePreviewEnded"),
  licenceInstalled: key("audit.licenceInstalled"),
  licenceRemoved: key("audit.licenceRemoved"),
  guestExpiryFixed: key("audit.guestExpiryFixed"),
  guestExpiryMoved: key("audit.guestExpiryMoved"),
  guestExpiryExtended: key("audit.guestExpiryExtended"),
  guestExpiryAdvanced: key("audit.guestExpiryAdvanced"),
  guestExpiryRemoved: key("audit.guestExpiryRemoved"),
  guestExpired: key("audit.guestExpired"),
  guestReactivated: key("audit.guestReactivated"),
  guestToMember: key("audit.guestToMember"),
  memberToGuest: key("audit.memberToGuest"),
  guestPurged: key("audit.guestPurged"),
  importApplied: key("audit.importApplied"),
  unknown: key("audit.unknown"),
} as const;

export function SpaceAuditScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { current } = useSpace();
  useSectionGuard("audit");
  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.bg }]}>
      {current ? <Journal spaceId={current.id} spaceName={current.name} community={current.edition === "community"} /> : <BackHeader title="" />}
    </SafeAreaView>
  );
}

type Loaded = { category: string; entries: AuditEntry[]; next?: string };

function Journal({ spaceId, spaceName, community }: { spaceId: string; spaceName: string; community: boolean }) {
  const { getAudit, getSpaceMembers, listRoles, listGroups } = useApi();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale, timeZone } = useLocale();
  const dayLabel = useDayLabel();
  const [category, setCategory] = useState<AuditCategory | "">("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [tick, setTick] = useState(0);
  // A newer request makes an older answer stale: a filter changed, or the log was read again.
  const request = useRef(0);

  // How the next reading lands: a live change merges the fresh first page into what is loaded, a pull,
  // a retry or another category starts over.
  const how = useRef<"merge" | "reset">("reset");
  const reload = useCallback(() => {
    how.current = "reset";
    setTick((n) => n + 1);
  }, []);
  const reloadLive = useCallback(() => {
    how.current = "merge";
    setTick((n) => n + 1);
  }, []);
  useReloadOn((e) => affects.permissions(e, spaceId), reloadLive, 500);

  useEffect(() => {
    const mine = ++request.current;
    const merging = how.current === "merge";
    how.current = "reset";
    getAudit(spaceId, { category: category || undefined, limit: PAGE }).then(
      (page) => {
        if (mine !== request.current) return;
        setLoaded((prev) =>
          merging && prev && prev.category === category
            ? { category, entries: mergeFirstPage(prev.entries, page.entries), next: prev.next }
            : { category, entries: page.entries, next: page.next },
        );
        setFailed(false);
      },
      () => {
        if (mine === request.current) setFailed(true);
      },
    );
  }, [getAudit, spaceId, category, tick]);

  // The names the log keeps as ids: people, groups and roles, as the lists know them today.
  const members = useLoad(`members:${spaceId}`, (signal) => getSpaceMembers(spaceId, signal));
  const roles = useLoad(`roles:${spaceId}`, () => listRoles(spaceId));
  const groups = useLoad(`groups:${spaceId}`, () => listGroups(spaceId));
  const nameById = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m.name])), [members.data]);

  const entries = loaded && loaded.category === category ? loaded.entries : null;
  const next = loaded && loaded.category === category ? loaded.next : undefined;

  const loadMore = async () => {
    if (!next || more) return;
    const mine = request.current;
    setMore(true);
    try {
      const page = await getAudit(spaceId, { category: category || undefined, before: next, limit: PAGE });
      if (mine === request.current) setLoaded((prev) => (prev && prev.category === category ? { category, entries: mergePages(prev.entries, page.entries), next: page.next } : prev));
    } catch {
      feel("failure");
    } finally {
      setMore(false);
    }
  };

  const roleByName = (name: string): Role | undefined => roles.data?.find((r) => r.name === name && r.systemKey);
  const roleName = (name: string) => {
    const known = roleByName(name);
    const system = known ? systemRoleKey(known) : null;
    return system ? t(SYSTEM_ROLE_LABEL[system]) : name;
  };
  const words: Words = {
    somebody: t("audit.somebody"),
    deletedAccount: t("audit.deletedAccount"),
    aRole: t("audit.aRole"),
    aGroup: t("audit.aGroup"),
    formerMembers: (count) => t("audit.formerMembers", { count }),
    everyone: (guests) => (guests ? t("access.allGuests") : t("channel.everyoneInSpace")),
    readers: t("audit.readersOfChannel"),
    resourceWord: (of) => t(RESOURCE_WORD[of]),
    resourceUnnamed: (of) => t(RESOURCE_UNNAMED[of]),
    theChannel: t("audit.theChannel"),
    aChannel: t("audit.aChannel"),
    legacy: (role) => (role in LEGACY_LABEL ? t(LEGACY_LABEL[role as keyof typeof LEGACY_LABEL]) : role),
    roleName,
  };
  const dateText = (iso: string, kind: "long" | "short") =>
    new Intl.DateTimeFormat(locale, kind === "long" ? { timeZone: "UTC", dateStyle: "medium" } : { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(iso));

  const lineOf = (entry: AuditEntry) => {
    const line = auditLine(entry, (id) => nameById.get(id), {
      group: (id) => groups.data?.find((g) => g.id === id)?.name,
      role: (id) => roles.data?.find((r) => r.id === id),
    });
    // `plural` sentences read their count; the rest ignore it.
    const text = String(t(SENTENCE[line.sentence] as never, fillFor(line, dateText) as never));
    const kind: Kind = line.values.resourceKind === "file" || line.values.resourceKind === "calendar" ? line.values.resourceKind : "channel";
    const diff = line.diff;
    const chipWords: ChipWords = {
      permission: (name) => (PERMISSION_TEXT[name] ? String(t(PERMISSION_TEXT[name].title as never)) : name),
      level: (name) => {
        const level = String(t(levelLabelKey(kind, name as Level) as never));
        return diff && diff.added.length > 0 && diff.removed.length > 0 ? level : t("audit.levelChip", { level });
      },
      role: roleName,
      viaGroup: (role) => t("audit.viaGroup", { role }),
      standing: (what) => (what === "member" ? t("invite.member") : t("invite.guest")),
      until: (iso) => t("audit.accessUntil", { date: dateText(iso, "long") }),
      space: t("audit.accessTo", { space: spaceName }),
      noEnd: t("guests.noEnd"),
    };
    return { runs: lineRuns(text, line.slots, words), chips: chipsOf(line, chipWords) };
  };

  const chips: Chip<AuditCategory | "">[] = [{ key: "", label: t("discussions.filterAll") }, ...AUDIT_CATEGORIES.map((k) => ({ key: k, label: t(CATEGORY_LABEL[k]) }))];
  const today = dayKey(new Date(), timeZone);
  const days = entries ? groupEntriesByDay(entries, timeZone) : [];

  const pulled = () => {
    feel("refresh");
    reload();
  };

  return (
    <>
      <BackHeader title={t("spaceSections.audit")} subtitle={t("audit.sub")} />
      <Chips chips={chips} value={category} onChange={(next) => {
          // The other category starts clean: a failure of the last one is not its own.
          setFailed(false);
          setCategory(next);
        }} />
      {!entries ? (
        <LoadState error={failed ? { offline: false } : null} onRetry={reload} />
      ) : (
        <SectionList
          sections={days.map(({ day, entries: list }) => ({ day, data: list }))}
          keyExtractor={(entry) => entry.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.page}
          refreshControl={<RefreshControl refreshing={false} onRefresh={pulled} />}
          ListHeaderComponent={
            <>
              {community ? (
                <View style={[styles.note, { backgroundColor: s.selected, borderColor: c.lineStrong }]}>
                  <Info size={18} color={c.ink} style={styles.noteIcon} />
                  <Text variant="small" tone="body" style={styles.noteText}>
                    {t("audit.communityBanner")}
                  </Text>
                </View>
              ) : null}
              {failed ? (
                <Text variant="small" tone="danger" accessibilityRole="alert" style={styles.failed}>
                  {t("audit.failed")}
                </Text>
              ) : null}
            </>
          }
          ListEmptyComponent={<EmptyState icon={FileText} title={t("audit.empty")} />}
          renderSectionHeader={({ section }) => (
            <Text variant="label" tone="muted" accessibilityRole="header" style={styles.dayHead}>
              {dayLabel(section.day, today)}
            </Text>
          )}
          renderItem={({ item: entry }) => {
            const { runs, chips: signed } = lineOf(entry);
            return (
              <View style={styles.row}>
                <Avatar name={entry.actor?.name ?? "?"} src={entry.actor?.avatarUrl} size={36} />
                <View style={styles.text}>
                  <Text variant="small" tone="body">
                    {runs.map((run, i) => (run.bold ? <Text key={i} variant="smallStrong">{run.text}</Text> : run.text))}
                  </Text>
                  {signed.length > 0 ? (
                    <View style={styles.pastilles}>
                      {signed.map((chip, i) => (
                        <View key={`${chip.sign}${i}`} style={[styles.pastille, { backgroundColor: chip.sign === "+" ? s.successBg : s.dangerBg }]}>
                          <Text variant="tiny">{`${chip.sign === "+" ? "+" : "−"} ${chip.text}`}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <Text variant="tiny" tone="muted">
                    {timeOf(entry.at, locale, timeZone)}
                  </Text>
                </View>
              </View>
            );
          }}
          ListFooterComponent={
            next ? (
              <View style={styles.more}>
                <Button variant="secondary" size="sm" label={t("audit.more")} onPress={() => void loadMore()} busy={more} />
              </View>
            ) : null
          }
        />
      )}
    </>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },
    failed: { marginBottom: 12 },
    dayHead: { marginTop: 16, marginBottom: 10 },
    note: { flexDirection: "row", gap: 10, marginBottom: 4, padding: 12, borderRadius: shape.radius.m, borderWidth: shape.hairline },
    noteIcon: { marginTop: 1 },
    noteText: { flex: 1 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 10 },
    text: { flex: 1, minWidth: 0, gap: 2 },
    pastilles: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 2 },
    pastille: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: shape.radius.s },
    more: { alignItems: "center", paddingTop: 12 },
  }),
);
