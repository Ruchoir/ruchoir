/**
 * The repetition as the form says it: the usual rules in words (the web's phrases, from the shared
 * `rulePhrase`), and what the draft repeats.
 */
import { parseRule, presetRule, rulePhrase, withStartDay, type Preset, type Translate } from "@ruchoir/client/calendarLogic";

import type { EventDraft } from "../../../logic/eventForm.ts";

export const USUAL_RULES = ["daily", "workdays", "weekly", "monthly", "yearly"] as const satisfies readonly Preset[];

/** The usual rules for a series starting on `startDay`: "Tous les mercredis", "Le 14 de chaque mois"... */
export function repeatChoices(startDay: string, locale: string, t: Translate): { preset: (typeof USUAL_RULES)[number]; label: string }[] {
  return USUAL_RULES.map((preset) => ({ preset, label: rulePhrase(parseRule(presetRule(preset, startDay)!)!, startDay, locale, t) }));
}

/** What the draft repeats, in words: nothing, an imported rule, a usual one or the custom one. */
export function repeatLabel(d: EventDraft, locale: string, t: Translate, words: { none: string; imported: string }): string {
  if (d.preset === "imported") return words.imported;
  if (d.preset === "custom") return rulePhrase(withStartDay(d.custom, d.startDay), d.startDay, locale, t);
  if (d.preset === "none") return words.none;
  return rulePhrase(parseRule(presetRule(d.preset, d.startDay)!)!, d.startDay, locale, t);
}
