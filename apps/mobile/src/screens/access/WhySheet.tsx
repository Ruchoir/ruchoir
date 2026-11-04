/**
 * "Pourquoi ?" (mockup 10): why a person has, or lacks, each right on a channel, a file, a folder or a
 * calendar, read step by step in the order Ruchoir applies it, then the decision for each level of
 * rights. Read only. The explanation is the API's; the sentences are the web's (the shared logic).
 */
import { type AccessView } from "@ruchoir/client";
import { labelOf, PERMISSION_TEXT, type ChainLevel } from "@ruchoir/client/permissionsLogic";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Check, X } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import { useSharedT } from "../../i18n/sharedT";
import { resultRows, whyCards, type WhyCard } from "../../logic/accessScreen";
import type { RootParams } from "../../navigation/types";
import { affects } from "../../realtime/events";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useAccess, useAccessNames } from "./useAccess";

/** The levels the access passes through, from the top: each folder above a file, then the item. The web reads the same chain. */
async function chainOf(getAccess: (spaceId: string, kind: "file", id: string) => Promise<AccessView>, spaceId: string, view: AccessView, itemName: string): Promise<ChainLevel[]> {
  const first = view.resource.parent && !view.resource.parent.hidden ? view.resource.parent : undefined;
  if (view.resource.kind !== "file" || !first) return [{ id: view.resource.id, name: itemName, item: true }];
  const levels: ChainLevel[] = [{ id: first.id, name: first.name ?? "", item: false }];
  let next: { id?: string; name?: string; hidden: boolean } | undefined = first;
  for (let depth = 0; depth < 8 && next?.id; depth++) {
    const above: AccessView | undefined = await getAccess(spaceId, "file", next.id).catch(() => undefined);
    const up: { id?: string; name?: string; hidden: boolean } | undefined = above?.resource.parent;
    if (!up || up.hidden) break;
    levels.unshift({ id: up.id, name: up.name ?? "", item: false });
    next = up;
  }
  return [...levels, { id: view.resource.id, name: itemName, item: true }];
}

export function WhySheet() {
  const { params } = useRoute<RouteProp<RootParams, "why">>();
  const { kind, resourceId, userId, title, folder = false } = params;
  const { explainAccess, getAccess } = useApi();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const say = useSharedT();
  const { locale } = useLocale();
  const { c, s } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { spaceId, view, error, reload } = useAccess(kind, resourceId, { toastWhenGone: false });
  const { members, roles } = useAccessNames(spaceId);
  const why = useLoad(spaceId ? `why:${spaceId}:${kind}:${resourceId}:${userId}` : null, () => explainAccess(spaceId!, kind, resourceId, userId));
  // The chain climbs the parents: it is read again when the access changes, and when the item moves
  // to another folder (the parent is part of its key).
  const chain = useLoad(spaceId && view ? `whyChain:${spaceId}:${kind}:${resourceId}:${view.resource.parent?.id ?? ""}` : null, () => chainOf(getAccess, spaceId!, view!, title));
  useReloadOn(
    (e) => !!spaceId && affects.access(e, kind, spaceId, resourceId),
    () => {
      why.reload();
      chain.reload();
    },
    300,
  );

  const name = why.data?.person.name ?? members.find((m) => m.userId === userId)?.name ?? "";
  const resource = kind === "channel" ? `#${title}` : title;
  const permissionName = (permission: string) => {
    const text = PERMISSION_TEXT[permission];
    return text ? say(text.title) : permission;
  };
  const list = (items: string[]) => new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const roleName = (ref: Parameters<typeof labelOf>[0], hidden: string) => {
    const label = labelOf(ref, roles);
    return label.key ? say(label.key) : (label.name ?? hidden);
  };

  const ready = why.data && chain.data;
  const cards: WhyCard[] = ready ? whyCards({ say, kind, isFolder: folder, person: name, locale, permissionName, list, roleName }, why.data!, chain.data!) : [];
  const results = why.data ? resultRows(say, kind, why.data) : [];

  return (
    // A sheet's root is one scroll view, its head pinned (see AGENTS.md).
    <ScrollView style={{ backgroundColor: c.bg }} stickyHeaderIndices={[0]} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      <View style={{ backgroundColor: c.surface }}>
        <SheetHeader title={t("access.whyLink")} subtitle={name ? t("why.headSub", { person: name, resource }) : undefined} onClose={() => navigation.goBack()} />
      </View>
      {!ready ? (
        <LoadState error={why.error ?? chain.error ?? error} onRetry={() => {
          why.reload();
          chain.reload();
          reload();
        }} />
      ) : (
        <View style={styles.scroll}>
          <Text variant="small" tone="body">
            {t("why.subtitle")}
          </Text>
          {cards.length === 0 ? (
            <Text variant="small" tone="muted">
              {t("why.noSteps")}
            </Text>
          ) : null}
          {cards.map((card, i) => {
            const warn = card.type === "locks" && card.label !== "";
            return (
              <View key={i} style={[styles.card, warn ? { backgroundColor: c.sun, borderColor: s.edge } : { backgroundColor: c.surface, borderColor: c.line }]}>
                {card.label ? (
                  <Text variant="label" tone={warn ? "onPastel" : "muted"}>
                    {card.label}
                  </Text>
                ) : null}
                <Text variant="small" tone={warn ? "onPastel" : "body"}>
                  {card.body}
                </Text>
              </View>
            );
          })}
          {results.length > 0 ? (
            <>
              <Text variant="label" tone="muted" style={styles.head}>
                {t("why.resultFor", { name })}
              </Text>
              {results.map((row) => (
                <View key={row.id} style={[styles.card, styles.result, row.granted ? { backgroundColor: c.mint, borderColor: s.edge } : { backgroundColor: c.surface, borderColor: c.line }]}>
                  {row.granted ? <Check size={18} color={c.onPastel} /> : <X size={18} color={c.muted} />}
                  <View style={styles.text}>
                    <Text variant="bodyStrong" tone={row.granted ? "onPastel" : "strong"}>
                      {row.label}
                    </Text>
                    <Text variant="tiny" tone={row.granted ? "onPastel" : "muted"}>
                      {row.reason}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    scroll: { padding: 16, gap: 10, paddingBottom: 40 },
    head: { paddingTop: 8 },
    card: { gap: 2, padding: 12, borderRadius: shape.radius.l, borderWidth: shape.hairline },
    result: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    text: { flex: 1, minWidth: 0 },
  }),
);
