// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";

import { capitalFirst, closeSentence, joinClosed, tidyPeriods } from "../src/permissionsLogic/sentences.ts";
import { guestNoticeDetail, guestNoticeSummary } from "../src/permissionsLogic/guestNotices.ts";

test("a_period_after_an_abbreviation_is_not_doubled", () => {
  assert.equal(tidyPeriods("Jusqu'au 7 nov.. Vous pouvez prolonger son accès."), "Jusqu'au 7 nov. Vous pouvez prolonger son accès.");
  assert.equal(tidyPeriods("Bis zum 7. Nov.."), "Bis zum 7. Nov.");
  // An ellipsis is not an abbreviation's period.
  assert.equal(tidyPeriods("Et puis..."), "Et puis...");
  assert.equal(tidyPeriods("Rien d'autre."), "Rien d'autre.");
});

test("a_sentence_without_its_end_gets_one_and_never_a_second", () => {
  assert.equal(closeSentence("Votre accès se termine dans 3 jours"), "Votre accès se termine dans 3 jours.");
  assert.equal(closeSentence("Jusqu'au 7 nov."), "Jusqu'au 7 nov.");
  assert.equal(closeSentence("Vraiment ?"), "Vraiment ?");
  assert.equal(closeSentence("Et voilà…"), "Et voilà…");
  assert.equal(closeSentence(""), "");
  assert.equal(joinClosed(["Votre accès se termine dans 3 jours", "Après le 7 nov., vous ne pourrez plus ouvrir cet espace."]), "Votre accès se termine dans 3 jours. Après le 7 nov., vous ne pourrez plus ouvrir cet espace.");
});

test("an_assembled_sentence_starts_with_a_capital", () => {
  assert.equal(capitalFirst("le verrou privé ne change rien.", "fr"), "Le verrou privé ne change rien.");
  assert.equal(capitalFirst("", "fr"), "");
  assert.equal(capitalFirst("Déjà", "fr"), "Déjà");
});

test("the_guest_detail_never_doubles_the_period_of_a_short_date", () => {
  const say = (which: string, vars: Record<string, string>) => (which === "soonBare" ? `Jusqu'au ${vars.date}. Vous pouvez prolonger son accès.` : "");
  assert.equal(guestNoticeDetail({ kind: "guest_expiry_soon", endsAt: "2026-11-07T00:00:00Z" }, () => "7 nov.", say), "Jusqu'au 7 nov. Vous pouvez prolonger son accès.");
});

test("the_notice_counts_the_days_from_the_end_not_from_the_day_it_was_sent", () => {
  const say = (which: "soon" | "ending", vars: Record<string, string>) => `${which}:${Object.values(vars).join("|")}`;
  // Sent with 7 days left, read 4 days later: the end is in 3 days.
  const n = { kind: "guest_expiry_soon", actor: "Thomas Girard", spaceName: "Atelier Dupont", daysLeft: 7, endsAt: "2026-11-07T12:00:00Z" };
  const at = { now: new Date("2026-11-04T10:00:00Z"), zone: "Europe/Paris" };
  assert.equal(guestNoticeSummary(n, "fr", say, at), "soon:Thomas Girard|dans 3 jours");
  // Without the end, the frozen count is all there is.
  assert.equal(guestNoticeSummary({ ...n, endsAt: undefined }, "fr", say, at), "soon:Thomas Girard|dans 7 jours");
  // Without a clock, it keeps working as before.
  assert.equal(guestNoticeSummary(n, "fr", say), "soon:Thomas Girard|dans 7 jours");
});
