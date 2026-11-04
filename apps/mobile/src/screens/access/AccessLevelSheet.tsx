/**
 * The level of one line (mockup 9, right): Aucun accès (which takes the line away, or reserves on the
 * base line), Lire, the middle level named after what the resource allows, Gérer, and Personnalisé.
 * The current level is ticked; one that cannot be given says why. It writes at once and the access
 * screen under it reads again on the local `permissions` event.
 */
import { refusalOf } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Ban, Check, Eye, MessageSquare, Shield, SlidersHorizontal, type LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { useSharedT } from "../../i18n/sharedT";
import { customiseDecision, findEntry, levelRows, type LevelRow } from "../../logic/accessScreen";
import { refusalSaid } from "../../logic/refusals";
import type { RootParams } from "../../navigation/types";
import { useRealtimeActions } from "../../realtime/RealtimeProvider";
import { useSession } from "../../session/SessionProvider";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { useEntryName } from "./AccessParts";
import { useAccess, useAccessNames } from "./useAccess";

export function AccessLevelSheet() {
  const { params } = useRoute<RouteProp<RootParams, "accessLevel">>();
  const { kind, resourceId, target } = params;
  const { setAccessLevel, removeAccessEntry } = useApi();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { t } = useTranslation();
  const say = useSharedT();
  const { c, s } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { emit } = useRealtimeActions();
  const { state } = useSession();
  const me = state.kind === "signedIn" ? state.user.id : undefined;
  const { spaceId, view, gone, error, reload } = useAccess(kind, resourceId, { toastWhenGone: false });
  const names = useAccessNames(spaceId);
  const nameOf = useEntryName();
  const [busy, setBusy] = useState(false);

  const entry = view ? findEntry(view.entries, target) : undefined;
  // The line went away while the sheet was open (removed from another device): nothing left to pick.
  const vanished = !!view && !entry;
  if (!view || !entry || !spaceId || gone) {
    return (
      <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={styles.content}>
        {vanished ? <Text tone="muted">{t("access.gone")}</Text> : <LoadState error={error} onRetry={reload} />}
      </ScrollView>
    );
  }
  const name = nameOf(entry, names);
  const adminRole = entry.target.kind === "role" && names.roles.some((r) => r.id === entry.target.id && r.systemKey === "administrator");
  const customise = customiseDecision(kind, view, entry, adminRole);
  const editable = view.may.edit && !view.archived && !entry.inheritedFrom;
  const rows = levelRows(kind, view.may, entry, me, { editable, customise });

  const done = (told: boolean) => {
    feel("success");
    if (told) emit({ type: "permissions", spaceId });
    navigation.goBack();
  };
  const fail = (err: unknown) => {
    const said = refusalSaid(refusalOf(err));
    toast(said ? String(t(said.key as never, said.vars as never)) : t("compose.editFailed"), "failure");
    reload();
  };
  const pick = async (row: LevelRow) => {
    if (busy || row.disabled) return;
    if (row.effect === "customise") {
      navigation.replace("customise", { kind, resourceId, target });
      return;
    }
    if (row.selected) return navigation.goBack();
    setBusy(true);
    try {
      if (row.effect === "remove") await removeAccessEntry(spaceId, kind, resourceId, entry.id!);
      else await setAccessLevel(spaceId, kind, resourceId, { kind: entry.target.kind, id: entry.target.id }, row.id as "none" | "read" | "contribute" | "manage");
      done(true);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const icon: Record<LevelRow["id"], { Icon: LucideIcon; tint: string }> = {
    remove: { Icon: Ban, tint: s.sunken },
    none: { Icon: Ban, tint: s.sunken },
    read: { Icon: Eye, tint: c.sky },
    contribute: { Icon: MessageSquare, tint: c.mint },
    manage: { Icon: Shield, tint: c.sun },
    custom: { Icon: SlidersHorizontal, tint: c.pink },
  };
  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}>
      <Text variant="heading" style={styles.title}>
        {t("access.levelFor", { name })}
      </Text>
      {rows.map((row) => {
        const look = icon[row.id];
        return (
          <View key={row.id} style={row.disabled ? styles.off : undefined}>
            <ActionRow
              icon={look.Icon}
              tint={row.id === "remove" || row.id === "none" ? undefined : look.tint}
              title={say(row.titleKey)}
              subtitle={row.reasonKey ? say(row.reasonKey) : row.descKey ? say(row.descKey) : undefined}
              selected={row.selected}
              onPress={row.disabled ? undefined : () => void pick(row)}
              trailing={row.selected ? <Check size={20} color={c.ink} /> : undefined}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 24, gap: 6 },
  title: { marginBottom: 6 },
  off: { opacity: 0.5 },
});
