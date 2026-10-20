import type { FileLink } from "@ruchoir/client";
import { useRoute, type RouteProp } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { Copy, Link, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { useLocale } from "../../i18n/useLocale";
import type { RootParams } from "../../navigation/types";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { Button } from "../../ui/Button";
import { Chips } from "../../ui/Chips";
import { KeyboardForm } from "../../ui/KeyboardForm";
import { EmptyState, LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toast";

/** How long a new link lasts: no end, or a number of days (the web's choices, without a calendar). */
const EXPIRIES = ["never", "1", "7", "30"] as const;
type Expiry = (typeof EXPIRIES)[number];

/**
 * A file's public links (the web's): each with its end, whether it asks a password, how often it was
 * downloaded, copied with a tap, deleted after a question; and a new one, with an end and a password
 * if wanted, copied as soon as it is made.
 */
export function LinksSheet() {
  const { createLink, listLinks, revokeLink } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "fileLinks">>();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const { locale, timeZone } = useLocale();
  const toast = useToast();
  const file = params.file;
  const links = useLoad(`links:${file.id}`, (signal) => listLinks(file.id!, signal));
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

  const copy = (link: FileLink) =>
    void Clipboard.setStringAsync(link.url).then(
      () => toast(t("files.linkCopied")),
      () => toast(t("files.linkCopyFailed"), "failure"),
    );
  const revoke = (link: FileLink) =>
    Alert.alert(t("files.revokeConfirm"), undefined, [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("files.revokeLink"),
        style: "destructive",
        onPress: () =>
          void revokeLink(file.id!, link.id).then(
            () => {
              links.reload();
              toast(t("files.linkRevoked"));
            },
            () => toast(t("files.linkRevokeFailed"), "failure"),
          ),
      },
    ]);
  const create = async () => {
    setBusy(true);
    try {
      const expiresAt = expiry === "never" ? undefined : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
      const link = await createLink(file.id!, { expiresAt, password: password.trim() || undefined });
      setPassword("");
      links.reload();
      copy(link);
    } catch {
      toast(t("files.linkCreateFailed"), "failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardForm
      contentContainerStyle={styles.form}
      footer={
        <View style={[styles.foot, { borderTopColor: c.line, backgroundColor: c.surface }]}>
          <Button label={t("files.createLink")} busy={busy} onPress={() => void create()} />
        </View>
      }
    >
      <View style={styles.gutter}>
        <Text variant="heading">{t("files.publicLinks")}</Text>
        <Text variant="small" tone="muted">
          {t("files.publicLinksHint")}
        </Text>
      </View>
      {!links.data ? <LoadState error={links.error} onRetry={links.reload} /> : null}
      {links.data && links.data.length === 0 ? <EmptyState size="compact" icon={Link} title={t("files.noLinks")} /> : null}
      <View style={styles.gutter}>
        {links.data?.map((link) => (
          <View key={link.id} style={[styles.link, { borderColor: c.line, opacity: link.expired ? 0.6 : 1 }]}>
            <View style={styles.grow}>
              <Text variant="smallStrong" numberOfLines={1}>
                {link.url}
              </Text>
              <Text variant="tiny" tone="muted">
                {[
                  link.expired ? t("files.linkExpired") : link.expiresAt ? t("files.linkUntil", { date: date(link.expiresAt) }) : t("files.linkNoEnd"),
                  link.hasPassword ? t("files.linkWithPassword") : null,
                  t("files.linkDownloads", { count: link.downloads }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t("message.copyLink")} hitSlop={8} onPress={() => copy(link)} style={[styles.icon, { backgroundColor: s.sunken }]}>
              <Copy size={16} color={c.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t("files.revokeLink")} hitSlop={8} onPress={() => revoke(link)} style={[styles.icon, { backgroundColor: s.dangerBg }]}>
              <Trash2 size={16} color={s.danger} />
            </Pressable>
          </View>
        ))}
      </View>
      <Text variant="smallStrong" tone="muted" style={styles.gutter}>
        {t("files.linkExpiry")}
      </Text>
      <Chips
        chips={EXPIRIES.map((e) => ({ key: e, label: e === "never" ? t("files.linkNoEnd") : t("files.linkDays", { count: Number(e) }) }))}
        value={expiry}
        onChange={setExpiry}
      />
      <View style={styles.gutter}>
        <TextField label={t("signIn.password")} placeholder={t("files.linkPasswordPlaceholder")} value={password} onChangeText={setPassword} secret autoCapitalize="none" />
      </View>
    </KeyboardForm>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, paddingTop: 24, paddingBottom: 16 },
  gutter: { paddingHorizontal: 20, gap: 4 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  link: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, marginBottom: 8, borderRadius: radius.m, borderWidth: hairline },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  foot: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, borderTopWidth: hairline },
});
