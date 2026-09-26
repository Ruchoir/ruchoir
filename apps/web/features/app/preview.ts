/**
 * A message body flattened to one line of plain text, for a preview under a conversation's name.
 *
 * The body is markdown, and a preview is not the place to render it: asterisks, fences and link
 * syntax read as noise there. This keeps the words and drops the marks. It is not a parser, and it
 * does not need to be one: the preview is cut to a line anyway, and the conversation itself renders
 * the body properly.
 */
export function oneLine(markdown: string): string {
  return (
    markdown
      // A fenced block is elided: its contents are not a sentence.
      .replace(/```[\s\S]*?(```|$)/g, " … ")
      // Links keep their text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis, inline code and strike marks.
      .replace(/(\*\*|__|\*|_|~~|`)/g, "")
      // Line prefixes: quotes, headings, list bullets, checklist boxes.
      .replace(/^\s{0,3}(>+|#{1,6}|[-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
