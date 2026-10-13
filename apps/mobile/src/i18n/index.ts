/**
 * The translation runtime, the same as the web's: i18next (developed in Europe), the six
 * dictionaries bundled with the app, French as the source and the fallback.
 *
 * The language is the phone's when Ruchoir speaks it, French otherwise.
 */
import { createInstance, type ParseKeys } from "i18next";
import { getLocales } from "expo-localization";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import de from "./dictionaries/de.json";
import en from "./dictionaries/en.json";
import es from "./dictionaries/es.json";
import fr from "./dictionaries/fr.json";
import it from "./dictionaries/it.json";
import pl from "./dictionaries/pl.json";

/** French is the contract: a key missing from another dictionary is a type error there. */
export type Dictionary = typeof fr;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Dictionary };
  }
}

export type Locale = "fr" | "en" | "es" | "de" | "it" | "pl";
export type DictKey = ParseKeys;

const resources: Record<Locale, { translation: Dictionary }> = {
  fr: { translation: fr },
  en: { translation: en satisfies Dictionary },
  es: { translation: es satisfies Dictionary },
  de: { translation: de satisfies Dictionary },
  it: { translation: it satisfies Dictionary },
  pl: { translation: pl satisfies Dictionary },
};

/** The first of the phone's languages that Ruchoir speaks, else French. */
export function deviceLocale(): Locale {
  for (const { languageCode } of getLocales()) {
    if (languageCode && languageCode in resources) return languageCode as Locale;
  }
  return "fr";
}

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: deviceLocale(),
  fallbackLng: "fr",
  // React escapes what it renders; escaping here too would draw `&#39;` for an apostrophe.
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** `t` and the active language, typed against the French dictionary. */
export function useTranslation() {
  return useReactTranslation();
}

export default i18n;
