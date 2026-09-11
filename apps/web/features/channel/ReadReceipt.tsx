import { Icon } from "@/components/ds";

/**
 * Who has read a message, shown on hover under one's own messages.
 *
 * Built from the conversation's read cursors: one per person, saying where they have read up to, so
 * everything at or before that point has been seen by them. It used to say "Lu" under every message
 * of every author, with no data behind it at all.
 *
 * What it says depends on how many people there are to read it, because a count means nothing
 * without its total:
 *
 * | Situation | Reads |
 * | --- | --- |
 * | Nobody yet | Non lu |
 * | One other person, who has read | Lu |
 * | Everyone, when there are several | Lu par tout le monde |
 * | One or two of several | Lu par Alice · Lu par Alice et Bob |
 * | Three or more, but not all | Lu par 3 personnes sur 5 |
 *
 * Naming one or two people rather than counting them is the useful case: it is the answer to "has
 * the person I am waiting on seen this". Past two, the names stop being readable in the corner of a
 * message and the proportion is what carries the meaning.
 */
export function ReadReceipt({ names, audience }: { names?: string[]; audience: number }) {
  const readers = names ?? [];
  const everyone = audience > 0 && readers.length >= audience;

  const label = (() => {
    if (readers.length === 0) return "Non lu";
    // A conversation with one other person has no "everyone" worth naming: it is that person.
    if (audience <= 1) return "Lu";
    if (everyone) return "Lu par tout le monde";
    if (readers.length === 1) return `Lu par ${readers[0]}`;
    if (readers.length === 2) return `Lu par ${readers[0]} et ${readers[1]}`;
    return `Lu par ${readers.length} personnes sur ${audience}`;
  })();

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        color: readers.length === 0 ? "var(--text-subtle)" : "var(--text-muted)",
      }}
      // The names in full, for the cases where only a number is drawn.
      title={readers.length > 2 ? readers.join(", ") : undefined}
    >
      {/* One tick for sent, two for read: the same distinction the label makes, at a glance. */}
      <Icon name={readers.length === 0 ? "check" : "check-check"} size={12} />
      {label}
    </span>
  );
}
