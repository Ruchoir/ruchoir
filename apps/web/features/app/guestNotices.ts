/** What the guest notices say, and how the app notices a space that ended for its guest. */

type NoticeLike = { kind: string; actor: string; spaceName: string; daysLeft?: number };

/** "dans 7 jours", "demain": how far an end lies, to sit in the middle of a sentence. */
export function whenLabel(days: number, locale: string): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day").toLocaleLowerCase(locale);
}

/**
 * The line of a guest notice: for whoever manages the guest ("L'accès de X se termine dans 7 jours")
 * or for the guest ("Votre accès à Y se termine demain"). `null` for any other kind. The words come
 * from the caller, which holds the translator.
 */
export function guestNoticeSummary(
  n: NoticeLike,
  locale: string,
  say: (which: "soon" | "ending", vars: Record<string, string>) => string,
): string | null {
  const when = whenLabel(n.daysLeft ?? 1, locale);
  if (n.kind === "guest_expiry_soon") return say("soon", { name: n.actor, when });
  if (n.kind === "guest_access_ending") return say("ending", { space: n.spaceName, when });
  return null;
}

/**
 * The spaces that were in the list and are not any more, and that nobody was told about yet. `told`
 * is kept by the caller and filled here, so the notice shows once however many frames follow.
 */
export function endedSpaces(before: { id: string; name: string }[], after: { id: string }[], told: Set<string>): { id: string; name: string }[] {
  const still = new Set(after.map((s) => s.id));
  const gone = before.filter((s) => !still.has(s.id) && !told.has(s.id));
  for (const s of gone) told.add(s.id);
  return gone;
}
