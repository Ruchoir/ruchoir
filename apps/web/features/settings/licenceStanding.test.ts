import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { licenceStanding } from "@ruchoir/client/permissionsLogic";
import type { LicenceView } from "@ruchoir/client/types";

const LOCALES = ["fr", "en", "de", "es", "it", "pl"];
const dict = (app: string, locale: string) =>
  JSON.parse(readFileSync(new URL(`../../../${app}/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const lookup = (d: Record<string, unknown>, path: string) =>
  path.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), d);

const base: LicenceView = { licenceId: "l", organisation: "A", seats: 5, used: 1, validUntil: "2027-01-01T00:00:00Z", edition: "enterprise" };
const views: LicenceView[] = [
  base,
  { ...base, edition: "frozen" },
  ...(["active", "suspended", "revoked", "unreachable", "expired", "not_yet", "clock"] as const).flatMap((status) =>
    (["online", "offline"] as const).map((mode) => ({ ...base, status, mode, unreachableSince: "2026-10-28T00:00:00Z", next: { validFrom: "a", validUntil: "b", seats: 5 } })),
  ),
  { ...base, status: "unreachable", mode: "online" },
];

test("every_word_the_licence_screen_shows_exists_in_six_languages_on_web_and_phone", () => {
  const keys = new Set<string>(["licence.lastCheckIn", "licence.lastCheckInHint", "licence.checkNever", "licence.offlineHint", "licence.checkNow", "licence.checking", "licence.checked", "licence.checkFailed", "licence.sentOnly", "licence.earlyHint", "licence.refusalService.serviceUnreachable", "licence.refusalService.checkTooSoon"]);
  for (const view of views) {
    const s = licenceStanding(view);
    keys.add(s.tag.key);
    if (s.modeKey) keys.add(s.modeKey);
    if (s.banner) keys.add(s.banner.key);
    if (s.next) keys.add(s.next.key);
  }
  for (const app of ["web/lib/i18n", "mobile/src/i18n"]) {
    for (const locale of LOCALES) {
      const d = dict(app, locale);
      for (const key of keys) assert.equal(typeof lookup(d, key), "string", `${app} ${locale} ${key}`);
      assert.ok(!String(lookup(d, "licence.foot")).includes("sans aucun appel extérieur"), `${app} ${locale} foot`);
    }
  }
});

test("no_licence_sentence_names_the_service_address", () => {
  for (const app of ["web/lib/i18n", "mobile/src/i18n"]) {
    for (const locale of LOCALES) {
      assert.ok(!JSON.stringify(dict(app, locale).licence).includes("licences.ruchoir.com"), `${app} ${locale}`);
    }
  }
});
