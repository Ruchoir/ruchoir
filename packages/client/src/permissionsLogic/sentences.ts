/**
 * The small repairs of a sentence assembled from pieces: a short date ends in its own period
 * ("7 nov."), and the template around it may end the sentence with another; a first sentence may
 * have none and be followed by a second; a sentence made after a colon may start in lower case.
 */

/** Two periods in a row become one ("7 nov.." after an abbreviation); an ellipsis ("...") is left alone. */
export function tidyPeriods(text: string): string {
  return text.replace(/(?<!\.)\.\.(?!\.)/g, ".");
}

/** The sentence with its end: a period unless it already ends with one (an abbreviation's own included), a "?", a "!", a colon or an ellipsis. */
export function closeSentence(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return trimmed;
  return /[.!?…:;]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Sentences one after the other, each closed, with one space between. */
export function joinClosed(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).map(closeSentence).join(" ");
}

/** The text with its first letter in capital, in the reader's language. */
export function capitalFirst(text: string, locale?: string): string {
  return text.length === 0 ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}
