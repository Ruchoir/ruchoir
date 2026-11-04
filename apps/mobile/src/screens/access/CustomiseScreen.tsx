/**
 * One line, right by right (mockup 11, left): each permission is Hérité, Autorisé or Refusé. What the
 * editor does not hold is locked with the reason; the result line says the nearest level and its
 * differences. Saving writes the line's rule, and clearing everything removes it. Paid edition only:
 * a community space reaches the locked row on the access screen instead.
 */
import { refusalOf } from "@ruchoir/client";
import { draftOf, levelLabelKey, PERMISSION_TEXT, setState, type Draft, type State } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Lock } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useSharedT } from "../../i18n/sharedT";
import { customiseView, findEntry } from "../../logic/accessScreen";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { feel } from "../../ui/haptics";
import { Segmented } from "../../ui/Segmented";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { useEntryName } from "./AccessParts";
import { useAccess, useAccessNames } from "./useAccess";

export function CustomiseScreen() {
  const { params } = useRoute<RouteProp<RootParams, "customise">>();
  const { kind, resourceId, target } = params;
  const { setAccessRule } = useApi();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const say = useSharedT();
  const { locale } = useLocale();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const { emit } = useRealtimeActions();
  const { spaceId, view, error, reload } = useAccess(kind, resourceId, { toastWhenGone: false });
  const names = useAccessNames(spaceId);
  const nameOf = useEntryName();
  // What the person changed, once they start: until then the draft is the line as saved.
  const [edited, setEdited] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const entry = view ? findEntry(view.entries, target) : undefined;
  if (!view || !entry || !spaceId) {
    return (
      <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.surface }]}>
        <SheetHeader title="" onClose={() => navigation.goBack()} />
        {view && !entry ? <Text tone="muted" style={styles.pad}>{t("access.gone")}</Text> : <LoadState error={error} onRetry={reload} />}
      </SafeAreaView>
    );
  }

  const name = nameOf(entry, names);
  const draft = edited ?? draftOf(entry);
  const data = customiseView(kind, entry, view.may.held, draft);
  const permissionName = (permission: string) => {
    const text = PERMISSION_TEXT[permission];
    return text ? say(text.title) : permission;
  };
  const list = (items: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const familyLabel = { read: t("customise.groupRead"), participate: t("customise.groupParticipate"), manage: t("profile.tabManage") } as const;
  const stateLabel: Record<State, string> = { inherited: t("customise.inherited"), allow: t("customise.allowed"), deny: t("customise.denied") };
  const where = kind === "channel" ? `#${view.resource.name}` : view.resource.name;
  const levelWord = say(levelLabelKey(kind, data.result.level));
  const resultLine = `${t("customise.resultLevel", { level: levelWord })}${data.result.except.length > 0 ? t("customise.resultExcept", { list: list(data.result.except.map(permissionName)) }) : ""}${data.result.plus.length > 0 ? t("customise.resultPlus", { list: list(data.result.plus.map(permissionName)) }) : ""}.`;

  const save = async () => {
    setBusy(true);
    try {
      await setAccessRule(spaceId, kind, resourceId, { kind: entry.target.kind, id: entry.target.id }, data.payload);
      feel("success");
      emit({ type: "permissions", spaceId });
      navigation.goBack();
    } catch (err) {
      const said = refusalSaid(refusalOf(err));
      toast(said ? String(t(said.key as never, said.vars as never)) : t("customise.saveFailed"), "failure");
      setBusy(false);
    }
  };

  return (
    <SafeAreaView edges={["top"]} style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("customise.title", { name })} subtitle={where} onClose={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text variant="small" tone="body" style={styles.pad}>
          {t("customise.subtitle")}
        </Text>
        {data.families.map((family) => (
          <View key={family.group}>
            <Text variant="label" tone="muted" style={[styles.pad, styles.head]}>
              {familyLabel[family.group]}
            </Text>
            {family.rows.map((row) => {
              const text = PERMISSION_TEXT[row.permission];
              return (
                <View key={row.permission} style={[styles.row, row.edited && { backgroundColor: s.selected }]}>
                  <View style={styles.title}>
                    <Text variant="bodyStrong">{permissionName(row.permission)}</Text>
                    {row.lock ? <Lock size={13} color={c.muted} /> : null}
                  </View>
                  <Text variant="tiny" tone="muted">
                    {row.lock ? (row.lock === "guest" ? t("access.guestCap") : t("customise.lockNotHeld")) : text ? say(text.desc) : ""}
                  </Text>
                  <View pointerEvents={row.lock || busy ? "none" : "auto"} style={[styles.choice, row.lock ? styles.off : undefined]}>
                    <Segmented
                      style={styles.flush}
                      options={(["inherited", "allow", "deny"] as const).map((key) => ({ key, label: stateLabel[key] }))}
                      value={row.state}
                      onChange={(next) => setEdited(setState(draft, row.permission, next))}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        ))}
        <View style={[styles.result, { borderColor: c.line }]}>
          <Text variant="smallStrong">{resultLine}</Text>
          <Text variant="tiny" tone="muted">
            {t("customise.resultNote")}
          </Text>
        </View>
        {!view.may.fine ? (
          <Text variant="small" tone="muted" style={styles.pad}>
            {t("customise.upsell")}
          </Text>
        ) : null}
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: c.line, backgroundColor: c.surface }]}>
        <Text variant="smallStrong" style={styles.count}>
          {data.changed === 0 ? t("customise.unchanged") : t("customise.changed", { count: data.changed })}
        </Text>
        <Button label={t("compose.save")} size="md" onPress={() => void save()} busy={busy} disabled={data.changed === 0 || !view.may.fine} />
      </View>
    </SafeAreaView>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    fill: { flex: 1 },
    scroll: { paddingBottom: 24, gap: 4 },
    pad: { paddingHorizontal: 16 },
    head: { paddingTop: 14, paddingBottom: 2 },
    row: { paddingHorizontal: 16, paddingVertical: 10, gap: 2 },
    title: { flexDirection: "row", alignItems: "center", gap: 6 },
    choice: { paddingTop: 6 },
    off: { opacity: 0.5 },
    flush: { marginHorizontal: 0 },
    result: { margin: 16, padding: 12, gap: 2, borderWidth: shape.hairline, borderRadius: shape.radius.m },
    bar: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: shape.hairline },
    count: { flex: 1 },
  }),
);
