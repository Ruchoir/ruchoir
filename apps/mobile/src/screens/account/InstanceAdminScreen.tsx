/**
 * "Instance administration", for an administrator of the instance (from their account), as the
 * web's `InstanceAdmin`: the instance's two settings (showing who administers it, notifications past
 * the open app), and giving access back to an account (a single-use password reset link, handed over
 * by the administrator: copied or shared, shown once).
 *
 * The API guards both; the entry is only offered to `isInstanceAdmin`.
 */
import {
  getInstanceSettings,
  issuePasswordResetLink,
  searchAccounts,
  updateInstanceSettings,
  type AdminUser,
  type InstanceSettings,
} from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, View } from "react-native";

import { useLoad } from "../../data/useLoad";
import { useTranslation } from "../../i18n";
import { hairline, radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { SearchField } from "../../ui/SearchField";
import { SheetHeader } from "../../ui/SheetHeader";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";
import { Section } from "./Section";
import { ToggleRow } from "./ToggleRow";

export function InstanceAdminScreen() {
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { c, s } = useTheme();
  const toast = useToast();

  const loaded = useLoad("instanceSettings", (signal) => getInstanceSettings(signal));
  const [changed, setChanged] = useState<InstanceSettings | null>(null);
  const settings = changed ?? loaded.data;
  const toggle = (patch: Partial<InstanceSettings>, done: (saved: InstanceSettings) => string) => {
    if (!settings) return;
    const before = settings;
    setChanged({ ...settings, ...patch });
    updateInstanceSettings(patch).then(
      (saved) => {
        setChanged(saved);
        toast(done(saved));
      },
      () => {
        setChanged(before);
        toast(t("admin.settingsSaveFailed"), "failure");
      },
    );
  };

  // Every account at once, then narrowed as the name or address is typed.
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const accounts = useLoad(`adminAccounts:${debounced}`, (signal) => searchAccounts(debounced, signal));

  const issue = (user: AdminUser) => {
    feel("menu");
    Alert.alert(t("admin.issueLink"), t("admin.issueConfirm", { name: user.name }), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("admin.issueLink"),
        onPress: () =>
          void issuePasswordResetLink(user.id).then(
            ({ url, expiresInSecs }) => {
              const minutes = Math.round(expiresInSecs / 60);
              Alert.alert(t("admin.linkFor", { name: user.name }), t("admin.linkValidity", { minutes }), [
                { text: t("security.copyCodes"), onPress: () => void Clipboard.setStringAsync(url).then(() => toast(t("files.linkCopied"))) },
                { text: t("viewer.share"), onPress: () => void Share.share({ message: url }) },
              ]);
            },
            () => toast(t("admin.issueFailed"), "failure"),
          ),
      },
    ]);
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.surface }]}>
      <SheetHeader title={t("admin.screenTitle")} onClose={() => navigation.goBack()} />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.page}>
        <Section label={t("admin.settingsTitle")}>
          {!settings ? (
            <LoadState error={loaded.error} onRetry={loaded.reload} />
          ) : (
            <>
              <ToggleRow
                title={t("admin.showAdmins")}
                text={t("admin.showAdminsDescription")}
                value={settings.showInstanceAdmins}
                onChange={(on) => toggle({ showInstanceAdmins: on }, (saved) => (saved.showInstanceAdmins ? t("admin.adminsShown") : t("admin.adminsHidden")))}
              />
              <ToggleRow
                title={t("admin.webPush")}
                text={t("admin.webPushDescription")}
                value={settings.webPushEnabled}
                onChange={(on) => toggle({ webPushEnabled: on }, (saved) => (saved.webPushEnabled ? t("admin.webPushOn") : t("admin.webPushOff")))}
              />
            </>
          )}
        </Section>

        <Section label={t("admin.accountsTitle")}>
          <Text variant="small" tone="muted">
            {t("admin.accountsIntro")}
          </Text>
          <SearchField value={query} onChange={setQuery} placeholder={t("admin.filterPlaceholder")} style={styles.search} />
          {!accounts.data ? (
            <LoadState error={accounts.error} onRetry={accounts.reload} />
          ) : accounts.data.length === 0 ? (
            <Text tone="muted">{t("admin.noMatch")}</Text>
          ) : (
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.line }]}>
              {accounts.data.map((user) => (
                <ActionRow
                  key={user.id}
                  title={user.name}
                  subtitle={user.status === "active" ? user.email : `${user.email} · ${user.status === "pending" ? t("admin.statusPending") : t("admin.statusLocked")}`}
                  onPress={() => issue(user)}
                  trailing={
                    user.isInstanceAdmin ? (
                      <View style={[styles.tag, { backgroundColor: s.sunken }]}>
                        <ShieldCheck size={12} color={c.ink} />
                        <Text variant="tiny">{t("details.roleAdmin")}</Text>
                      </View>
                    ) : undefined
                  }
                />
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingHorizontal: 16, paddingBottom: 40 },
  search: { marginHorizontal: 0 },
  card: { borderWidth: hairline, borderRadius: radius.l, paddingHorizontal: 12, paddingVertical: 4 },
  tag: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.s },
});
