/**
 * The Gestion tab of a member (mockup 3): their roles as toggles with the reason of each one that is
 * off, their standing (member or guest) with the end date and its presets, the groups they are in,
 * and removing them. Role changes wait for the save bar; the standing and the end date apply from
 * their own buttons. The API is the judge of everything this offers (`refusalSaid` words its refusals).
 */
import { refusalOf, type Group, type Member, type Role, type Workspace } from "@ruchoir/client";
import {
  choiceRefusal,
  dateBounds,
  daysLeft,
  expiryTone,
  gestionControls,
  inDaysLabel,
  memberAccessFor,
  presetToInstant,
  rightsOf,
  roleIdsToSave,
  rolesViaGroups,
  standingGain,
  standingLoss,
  type EndChoice,
  type Line,
  type RoleChoice,
} from "@ruchoir/client/permissionsLogic";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { Lock, UserMinus, Users } from "lucide-react-native";
import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { key, useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import {
  changeCount,
  deviceZone,
  draftOf,
  heldRoles,
  pickedDay,
  roleColourKey,
  shortDay,
  systemRoleKey,
  toggleRows,
  type ToggleReason,
} from "../../logic/memberScreen";
import { refusalSaid } from "../../logic/refusals";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { RoleChip } from "../../ui/RoleChip";
import { Text } from "../../ui/Text";
import { Toggle } from "../../ui/Toggle";
import { useToast } from "../../ui/Toast";
import { Section } from "../account/Section";
import { LEGACY_LABEL, SYSTEM_ROLE_LABEL } from "./SpaceMembersScreen";
import { LegacyRoles, useFailed, useRemoveMember } from "./MemberLegacy";
import { useSpace } from "../../space/SpaceProvider";

/** What a toggle's reason says, by key. */
const REASON_TEXT: Record<ToggleReason["key"], ReturnType<typeof key>> = {
  "groups.viaReason": key("groups.viaReason"),
  "groups.alsoDirect": key("groups.alsoDirect"),
  "roles.aboveYou": key("roles.aboveYou"),
  "roles.yourTopRole": key("roles.yourTopRole"),
};

/** Each sentence of the shared standing lines, by its key. */
const LINE_TEXT: Record<string, ReturnType<typeof key>> = {
  "guests.loseView": key("guests.loseView"),
  "guests.loseDirectory": key("guests.loseDirectory"),
  "guests.loseCeiling": key("guests.loseCeiling"),
  "guests.keepChannels": key("guests.keepChannels"),
  "guests.keepMessages": key("guests.keepMessages"),
  "guests.keepGroups": key("guests.keepGroups"),
  "guests.keepRoles": key("guests.keepRoles"),
  "guests.gainView": key("guests.gainView"),
  "guests.gainSeat": key("guests.gainSeat"),
  "guests.gainClearsDate": key("guests.gainClearsDate"),
};

type Props = {
  space: Workspace;
  member: Member;
  me?: Member;
  roles: Role[];
  groups: Group[];
  /** The person's data changed: read the people (and the roles' holders) again. */
  onChanged: () => void;
};

type Choices = RoleChoice<Role>[];

export function MemberManage({ space, member, me, roles, groups, onChanged }: Props) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { setMemberRoles } = useApi();
  const failed = useFailed();
  const remove = useRemoveMember(space, member, failed);
  const [edit, setEdit] = useState<{ base: string; set: Set<string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const rights = rightsOf(space);
  const viaGroups = rolesViaGroups(member, groups);
  const access = memberAccessFor<Role>({ member, me: me?.userId ?? "", edition: space.edition, roles, rights, viaGroups });
  const choices: Choices | null = access.mode === "roles" ? (access.choices as Choices) : null;
  // Another person's edit while this screen is open: what is saved is the truth, the draft starts over.
  const saved = member.roleIds?.join(",") ?? "";
  const draft = edit && edit.base === saved ? edit.set : null;
  const setDraft = (set: Set<string> | null) => setEdit(set ? { base: saved, set } : null);
  const mine = groups.filter((g) => g.memberIds.includes(member.userId));
  const first = member.name.split(" ")[0] ?? member.name;
  const count = choices && draft ? changeCount(draftOf(choices), draft) : 0;

  const save = async () => {
    if (!choices || !draft) return;
    setSaving(true);
    try {
      await setMemberRoles(space.id, member.userId, roleIdsToSave(roles, choices, draft));
      toast(t("details.roleChanged", { name: member.name }), "success");
      setDraft(null);
      onChanged();
    } catch (err) {
      const sentence = refusalSaid(refusalOf(err));
      if (sentence) toast(String(t(sentence.key as never, sentence.vars as never)), "failure");
      else failed(err, key("details.roleFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.fill}>
      <ScrollView contentContainerStyle={styles.box} keyboardShouldPersistTaps="handled">
        {choices ? (
          <RoleToggles member={member} me={me} choices={choices} draft={draft} setDraft={setDraft} />
        ) : access.mode === "held" || access.mode === "frozen" ? (
          <Section label={t("spaceSections.roles")} note={access.mode === "frozen" ? t("roles.frozenNote") : undefined}>
            <HeldChips member={member} roles={roles} groups={groups} />
          </Section>
        ) : access.mode === "above" ? (
          <Text variant="small" tone="muted" style={styles.note}>
            {t("roles.personAboveNote", { name: member.name })}
          </Text>
        ) : null}
        {access.mode === "fixed" ? <LegacyRoles space={space} member={member} withRemove={false} /> : null}

        {access.mode !== "fixed" ? <Standing space={space} member={member} roles={roles} rights={rights} first={first} onChanged={onChanged} /> : null}

        <Section label={t("spaceSections.groups")}>
          <View style={styles.wrap}>
            {mine.length === 0 ? (
              <Text variant="small" tone="muted">
                {t("members.noGroup")}
              </Text>
            ) : (
              mine.map((g) => (
                <View key={g.id} style={[styles.group, { borderColor: c.lineStrong }]}>
                  <Users size={12} color={c.muted} />
                  <Text variant="smallStrong">{g.name}</Text>
                </View>
              ))
            )}
          </View>
        </Section>

        <View style={styles.danger}>
          <ActionRow icon={UserMinus} title={t("spaceAdmin.remove")} danger onPress={remove} />
        </View>
      </ScrollView>
      {count > 0 ? (
        <View style={[styles.bar, { borderColor: c.line, backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Text variant="bodyStrong" style={styles.barText}>
            {t("roles.changes", { count })}
          </Text>
          <Button size="md" label={t("compose.save")} busy={saving} onPress={() => void save()} />
        </View>
      ) : null}
    </View>
  );
}

function HeldChips({ member, roles, groups }: { member: Member; roles: Role[]; groups: Group[] }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const held = heldRoles(member, roles, groups);
  return (
    <View style={styles.wrap}>
      {held.map(({ role, via }) => {
        const named = systemRoleKey(role);
        return <RoleChip key={role.id} label={named ? t(SYSTEM_ROLE_LABEL[named]) : role.name} colour={roleColourKey(role)} viaGroup={via.length > 0} />;
      })}
      {held.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("roles.membersOnly")}
        </Text>
      ) : null}
    </View>
  );
}

function RoleToggles({
  member,
  me,
  choices,
  draft,
  setDraft,
}: {
  member: Member;
  me?: Member;
  choices: Choices;
  draft: Set<string> | null;
  setDraft: (draft: Set<string> | null) => void;
}) {
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const current = draft ?? draftOf(choices);
  const rows = toggleRows(choices, current, { myTopRoleId: me?.roleIds?.[0] });
  const list = (names: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  return (
    <Section label={t("spaceSections.roles")}>
      {rows.map((row, index) => {
        const role = choices[index].role;
        const named = systemRoleKey(role);
        const reason = row.reason;
        return (
          <View key={row.roleId} style={[styles.toggleRow, row.changed && { backgroundColor: s.selected }]}>
            <View style={styles.toggleText}>
              <RoleChip label={named ? t(SYSTEM_ROLE_LABEL[named]) : role.name} colour={roleColourKey(role)} viaGroup={row.groupOnly} />
              {reason ? (
                <View style={styles.reason}>
                  {row.disabled && !row.groupOnly ? <Lock size={12} color={c.muted} /> : null}
                  <Text variant="tiny" tone="muted" style={styles.reasonText}>
                    {String(
                      "via" in reason
                        ? t(REASON_TEXT[reason.key] as never, { groups: list(reason.via), count: reason.via.length, name: member.name.split(" ")[0] } as never)
                        : t(REASON_TEXT[reason.key] as never),
                    )}
                  </Text>
                </View>
              ) : null}
            </View>
            <Toggle
              value={row.on}
              disabled={row.disabled}
              accessibilityLabel={named ? t(SYSTEM_ROLE_LABEL[named]) : role.name}
              onValueChange={(on) => {
                const next = new Set(current);
                if (on) next.add(row.roleId);
                else next.delete(row.roleId);
                setDraft(next);
              }}
            />
          </View>
        );
      })}
      {member.role === "guest" ? (
        <Text variant="small" tone="muted">
          {t("groups.guestCeiling")}
        </Text>
      ) : null}
    </Section>
  );
}

/** What a standing change tells before it is made, as the shared lines say it. */
function said(t: ReturnType<typeof useTranslation>["t"], lines: Line[], list: (names: string[]) => string): string {
  return lines.map((l) => String(t(LINE_TEXT[l.key] as never, { roles: list(l.names ?? []) } as never))).join("\n\n");
}

const CHOICES: { choice: EndChoice | "custom"; label: ReturnType<typeof key> }[] = [
  { choice: "week", label: key("guests.presetWeek") },
  { choice: "month", label: key("guests.presetMonth") },
  { choice: "quarter", label: key("guests.presetQuarter") },
  { choice: "custom", label: key("guests.presetCustom") },
  { choice: "none", label: key("guests.removeDate") },
];

/** The standing block: member or guest, the way to the other, and for a guest the end date and Prolonger. */
function Standing({ space, member, roles, rights, first, onChanged }: { space: Workspace; member: Member; roles: Role[]; rights: string[]; first: string; onChanged: () => void }) {
  const { setMemberRole, setGuestExpiry } = useApi();
  const { t } = useTranslation();
  const { c, s, dark } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { locale } = useLocale();
  const toast = useToast();
  const failed = useFailed();
  const { spaces } = useSpace();
  const navigation = useNavigation();
  const zone = deviceZone();
  const [now] = useState(() => new Date());
  const [choice, setChoice] = useState<EndChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const controls = gestionControls(member, rights);
  const guest = member.role === "guest";
  const days = member.expiresAt ? daysLeft(member.expiresAt, now, zone) : null;
  const soon = days !== null && expiryTone(days) === "soon";
  const list = (names: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  const since = member.joinedAt ? shortDay(member.joinedAt, locale, zone, now) : "";
  const standingLabel = member.role === "owner" ? LEGACY_LABEL.owner : guest ? LEGACY_LABEL.guest : LEGACY_LABEL.member;
  const bounds = dateBounds(now, zone);

  const say = (err: unknown, fallback: ReturnType<typeof key>) => {
    const sentence = refusalSaid(refusalOf(err));
    if (sentence) toast(String(t(sentence.key as never, sentence.vars as never)), "failure");
    else failed(err, fallback);
  };

  const toGuest = () =>
    Alert.alert(t("guests.passerInviteTitle", { name: member.name }), said(t, standingLoss(member, roles).loses, list), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("guests.passerInviteAction"),
        onPress: () =>
          void (async () => {
            setBusy(true);
            try {
              await setMemberRole(space.id, member.userId, "guest");
              toast(t("spaceAdmin.roleChanged"), "success");
              onChanged();
              spaces.reload();
            } catch (err) {
              say(err, key("guests.passerFailed"));
            } finally {
              setBusy(false);
            }
          })(),
      },
    ]);

  const toMember = () => {
    Alert.alert(t("guests.passerMembreTitle", { name: member.name }), said(t, standingGain(member), list), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("guests.passerMembreAction"),
        onPress: () =>
          void (async () => {
            setBusy(true);
            try {
              await setMemberRole(space.id, member.userId, "member");
              toast(t("spaceAdmin.roleChanged"), "success");
              onChanged();
              spaces.reload();
            } catch (err) {
              const refusal = refusalOf(err);
              if (refusal?.code === "seats_full") {
                // The guest keeps their access: the answer is shown, not thrown.
                Alert.alert(t("dialogs.seatsFull", { count: refusal.seats }), t("guests.seatsFullRest", { name: member.name }));
              } else {
                say(err, key("guests.passerFailed"));
              }
            } finally {
              setBusy(false);
            }
          })(),
      },
    ]);
  };

  const handOver = () =>
    Alert.alert(t("spaceAdmin.transferTitle"), t("spaceAdmin.transferBody", { name: member.name, space: space.name }), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("spaceAdmin.transferConfirm"),
        style: "destructive",
        onPress: () =>
          void (async () => {
            setBusy(true);
            try {
              await setMemberRole(space.id, member.userId, "owner");
              // The giver stepped down to admin in the same write: the space list carries my role.
              spaces.reload();
              toast(t("spaceAdmin.handedOver", { name: member.name }), "success");
              navigation.goBack();
            } catch (err) {
              say(err, key("spaceAdmin.roleFailed"));
            } finally {
              setBusy(false);
            }
          })(),
      },
    ]);

  const prolong = async () => {
    if (!choice || choiceRefusal(choice, new Date(), zone) !== null) return;
    setBusy(true);
    try {
      await setGuestExpiry(space.id, member.userId, presetToInstant(choice, new Date(), zone, member.expiresAt));
      toast(t("guests.updated"), "success");
      setChoice(null);
      onChanged();
    } catch (err) {
      say(err, key("guests.updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const pickDate = () => {
    const start = typeof choice === "object" && choice ? new Date(`${choice.date}T12:00:00`) : new Date();
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: start,
        mode: "date",
        minimumDate: new Date(`${bounds.min}T00:00:00`),
        maximumDate: new Date(`${bounds.max}T23:59:59`),
        onChange: (_, date) => {
          if (date) setChoice({ date: pickedDay(date) });
        },
      });
    } else {
      setPicking((on) => !on);
      if (!choice || typeof choice !== "object") setChoice({ date: pickedDay(start) });
    }
  };

  const customLabel = typeof choice === "object" && choice ? shortDay(presetToInstant(choice, now, zone) ?? now.toISOString(), locale, zone, now) : t("guests.presetCustom");

  return (
    <Section label={guest ? t("guests.accessSection") : t("roles.standing")}>
      <View style={[styles.card, { borderColor: c.lineStrong }]}>
        <View style={styles.cardHead}>
          <View style={styles.cardTitle}>
            {guest ? (
              <>
                <Text variant="bodyStrong">{member.expiresAt ? t("guests.guestUntil", { date: shortDay(member.expiresAt, locale, zone, now) }) : t("guests.noEnd")}</Text>
                {days !== null ? (
                  <Text variant="small" tone={soon ? "danger" : "muted"}>
                    {inDaysLabel(days, locale)}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Text variant="bodyStrong">{t(standingLabel)}</Text>
                {since ? (
                  <Text variant="small" tone="muted">
                    {t("roles.memberSince", { date: since })}
                  </Text>
                ) : null}
              </>
            )}
          </View>
          {controls.toGuest ? <Button size="sm" variant="secondary" label={t("guests.passerInviteAction")} disabled={busy} onPress={toGuest} /> : null}
          {controls.toMember ? <Button size="sm" variant="secondary" label={t("guests.passerMembreAction")} disabled={busy} onPress={toMember} /> : null}
        </View>
        {controls.toGuest ? (
          <Text variant="small" tone="muted">
            {t("guests.guestStatusNote")}
          </Text>
        ) : null}
        {controls.toMember ? (
          <Text variant="small" tone="muted">
            {t("guests.memberStatusNote")}
          </Text>
        ) : null}
        {guest ? (
          <Text variant="small" tone="muted">
            {member.expiresAt ? t("guests.remaining", { when: inDaysLabel(days ?? 0, locale), name: first }) : t("guests.noEndInfo")}
          </Text>
        ) : null}
        {controls.endControl ? (
          <>
            <Text variant="smallStrong">{t("guests.prolongBy")}</Text>
            <View style={styles.wrap}>
              {CHOICES.map(({ choice: option, label }) => {
                const on = option === "custom" ? typeof choice === "object" && choice !== null : choice === option;
                return (
                  <Pressable
                    key={String(option)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      feel("choice");
                      if (option === "custom") pickDate();
                      else {
                        setPicking(false);
                        setChoice(option);
                      }
                    }}
                    style={[styles.pill, { borderColor: on ? s.edge : c.lineStrong, backgroundColor: on ? s.selected : c.surface }]}
                  >
                    <Text variant={on ? "smallStrong" : "small"}>{option === "custom" ? customLabel : t(label)}</Text>
                  </Pressable>
                );
              })}
            </View>
            {picking && Platform.OS === "ios" && typeof choice === "object" && choice ? (
              <View style={styles.picker}>
                <DateTimePicker
                  value={new Date(`${choice.date}T12:00:00`)}
                  mode="date"
                  display="inline"
                  locale={locale}
                  themeVariant={dark ? "dark" : "light"}
                  minimumDate={new Date(`${bounds.min}T00:00:00`)}
                  maximumDate={new Date(`${bounds.max}T23:59:59`)}
                  onChange={(_, date) => {
                    if (date) setChoice({ date: pickedDay(date) });
                  }}
                />
              </View>
            ) : null}
            <Button
              size="md"
              label={choice === "none" ? t("guests.removeDate") : t("guests.prolong")}
              disabled={!choice}
              busy={busy}
              onPress={() => void prolong()}
              style={styles.prolong}
            />
          </>
        ) : null}
      </View>
      {space.role === "owner" && member.role === "member" ? (
        <Button size="sm" variant="link" label={t("roles.handOver")} disabled={busy} onPress={handOver} style={styles.handOver} />
      ) : null}
    </Section>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    box: { paddingHorizontal: 16, paddingBottom: 24 },
    bar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: shape.hairline },
    barText: { flex: 1 },
    note: { paddingTop: 16 },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    group: { flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, borderWidth: shape.hairline },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 4, borderRadius: shape.radius.s },
    toggleText: { flex: 1, minWidth: 0, gap: 4 },
    reason: { flexDirection: "row", alignItems: "center", gap: 4 },
    reasonText: { flexShrink: 1 },
    card: { gap: 10, padding: 14, borderRadius: shape.radius.l, borderWidth: shape.hairline },
    cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
    cardTitle: { flex: 1, minWidth: 0 },
    pill: { height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
    picker: { alignItems: "center" },
    prolong: { alignSelf: "flex-start" },
    handOver: { alignSelf: "flex-start" },
    danger: { paddingTop: 16 },
  }),
);
