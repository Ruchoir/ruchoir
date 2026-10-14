import { updateMyProfile } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Check, Languages } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { deviceLocale, key, useTranslation } from "../../i18n";
import { LANGUAGE_NAMES } from "../../i18n/languages";
import { useLocale } from "../../i18n/useLocale";
import type { RootParams } from "../../navigation/types";
import { AGENDA_VIEWS, DURATIONS, durationLabel, MODES, TEXT_SIZES, WEEK_STARTS, type TextSize, type ThemeMode } from "../../prefs/prefs";
import { setPrefs, usePrefs } from "../../prefs/store";
import { ACCENTS, type Accent } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { BackHeader } from "../../ui/BackHeader";
import { Chips } from "../../ui/Chips";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { Text } from "../../ui/Text";
import { NotificationPrefs } from "./NotificationPrefs";
import { Section } from "./Section";

const MODE_TEXT: Record<ThemeMode, ReturnType<typeof key>> = {
  auto: key("prefs.modeAuto"),
  day: key("prefs.modeDay"),
  night: key("prefs.modeNight"),
};
const SIZE_TEXT: Record<TextSize, ReturnType<typeof key>> = {
  s: key("prefs.sizeS"),
  m: key("prefs.sizeM"),
  l: key("prefs.sizeL"),
  xl: key("prefs.sizeXl"),
};
const ACCENT_TEXT: Record<Accent, ReturnType<typeof key>> = {
  sky: key("prefs.accentSky"),
  mint: key("prefs.accentMint"),
  violet: key("prefs.accentViolet"),
  pink: key("prefs.accentPink"),
};
const VIEW_TEXT = { list: key("agenda.list"), week: key("agenda.week"), month: key("agenda.month") };

/**
 * Preferences (mockup 11's "text size, theme, notifications"): how the app looks and speaks, how the
 * agenda opens, kept on this phone; and the account's notifications, kept on the server as the web's.
 */
export function PreferencesScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const { locale } = useLocale();
  const prefs = usePrefs();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  // 2026-06-14 is a Sunday: day n of the week is the 14th plus n.
  const dayName = (n: number) => {
    const name = weekday.format(new Date(Date.UTC(2026, 5, 14 + n, 12)));
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  };
  const length = (m: number) =>
    durationLabel(m, {
      minutes: (n) => t("prefs.minutes", { n }),
      hours: (n) => t("prefs.hours", { n }),
      hoursMinutes: (h, min) => t("prefs.hoursMinutes", { h, m: min }),
    });

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.bg }]} edges={["top"]}>
      <BackHeader title={t("account.preferences")} />
      <ScrollView contentContainerStyle={styles.content}>
        <Section label={t("prefs.appearance")}>
          <Text variant="smallStrong">{t("prefs.mode")}</Text>
          <Segmented
            options={MODES.map((mode) => ({ key: mode, label: t(MODE_TEXT[mode]) }))}
            value={prefs.mode}
            onChange={(mode) => setPrefs({ mode })}
            style={styles.segmented}
          />
          <Text variant="smallStrong" style={styles.gap}>
            {t("prefs.accent")}
          </Text>
          <View style={styles.swatches}>
            {ACCENTS.map((accent) => {
              const on = prefs.accent === accent;
              return (
                <Pressable
                  key={accent}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={t(ACCENT_TEXT[accent])}
                  onPress={() => setPrefs({ accent })}
                  style={[styles.swatch, { backgroundColor: c[accent], borderColor: on ? c.ink : c.line }]}
                >
                  {on ? <Check size={20} color={c.onPastel} strokeWidth={3} /> : null}
                </Pressable>
              );
            })}
          </View>
          <Text variant="smallStrong" style={styles.gap}>
            {t("prefs.textSize")}
          </Text>
          <Segmented
            options={TEXT_SIZES.map((size) => ({ key: size, label: t(SIZE_TEXT[size]) }))}
            value={prefs.textSize}
            onChange={(textSize) => setPrefs({ textSize })}
            style={styles.segmented}
          />
          <View style={styles.gap}>
            <ActionRow
              icon={Languages}
              tint={c.sky}
              title={prefs.locale ? LANGUAGE_NAMES[prefs.locale] : t("prefs.languagePhone", { name: LANGUAGE_NAMES[deviceLocale()] })}
              subtitle={t("prefs.language")}
              onPress={() => navigation.navigate("languageSheet")}
            />
          </View>
        </Section>

        <Section label={t("tabs.agenda")}>
          <Text variant="smallStrong">{t("prefs.agendaView")}</Text>
          <Segmented
            options={AGENDA_VIEWS.map((view) => ({ key: view, label: t(VIEW_TEXT[view]) }))}
            value={prefs.agendaView}
            onChange={(agendaView) => setPrefs({ agendaView })}
            style={styles.segmented}
          />
          <Text variant="smallStrong" style={styles.gap}>
            {t("prefs.weekStart")}
          </Text>
          <Segmented
            options={WEEK_STARTS.map((day) => ({ key: String(day), label: dayName(day) }))}
            value={String(prefs.weekStart)}
            onChange={(day) => setPrefs({ weekStart: Number(day) as 1 | 0 | 6 })}
            style={styles.segmented}
          />
          <Text variant="smallStrong" style={styles.gap}>
            {t("prefs.duration")}
          </Text>
          <View style={styles.chips}>
            <Chips
              chips={DURATIONS.map((m) => ({ key: String(m), label: length(m) }))}
              value={String(prefs.duration)}
              onChange={(m) => setPrefs({ duration: Number(m) })}
            />
          </View>
        </Section>

        <NotificationPrefs />

        <Text variant="small" tone="muted" style={styles.note}>
          {t("prefs.onThisPhone")}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/** The language: the phone's, or one of the six, saved on the account too as the web does. */
export function LanguageSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const prefs = usePrefs();
  const navigation = useNavigation();
  const pick = (locale: (typeof prefs)["locale"]) => {
    setPrefs({ locale });
    // What the server writes (mails, invitations) follows the language read here.
    void updateMyProfile({ locale: locale ?? deviceLocale() }).catch(() => {});
    navigation.goBack();
  };
  const tick = (on: boolean) => (on ? <Check size={20} color={c.ink} /> : undefined);
  return (
    <Sheet>
      <Text variant="heading">{t("prefs.language")}</Text>
      <ActionRow
        icon={Languages}
        tint={c.sky}
        title={t("prefs.languagePhone", { name: LANGUAGE_NAMES[deviceLocale()] })}
        selected={prefs.locale === null}
        trailing={tick(prefs.locale === null)}
        onPress={() => pick(null)}
      />
      {(Object.keys(LANGUAGE_NAMES) as (keyof typeof LANGUAGE_NAMES)[]).map((code) => (
        <ActionRow
          key={code}
          leading={
            <View style={[styles.code, { backgroundColor: c.surface, borderColor: c.line }]}>
              <Text variant="smallStrong">{code.toUpperCase()}</Text>
            </View>
          }
          title={LANGUAGE_NAMES[code]}
          selected={prefs.locale === code}
          trailing={tick(prefs.locale === code)}
          onPress={() => pick(code)}
        />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 48 },
  segmented: { marginHorizontal: 0 },
  gap: { marginTop: 8 },
  swatches: { flexDirection: "row", gap: 14 },
  swatch: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  chips: { marginHorizontal: -16 },
  note: { paddingTop: 24 },
  code: { width: 40, height: 40, borderRadius: 10, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});
