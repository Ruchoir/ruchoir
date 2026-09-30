/**
 * Pipe tables, as text: finding them in a message body and reading their cells.
 *
 * The composer draws a table as a real table with cells to fill, and writes it back as the pipe
 * table the message reader draws (`| a | b |`, a dashed row, rows). These two functions are the
 * way back: a body that is picked up to be edited is cut into its text and its tables, so each
 * table can be drawn as a table again. They touch no DOM, so they can be tested on strings.
 */

export type Segment = { kind: "text"; text: string } | { kind: "table"; rows: string[][] };

/** The cells of a line when it is a table row, or null. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/** The dashed row that makes a table one. */
function isRule(line: string): boolean {
  return /^\|(\s*:?-+:?\s*\|)+$/.test(line.trim());
}

/**
 * Cut a body into its text and its tables, in order. A table is a header row, the dashed row that
 * makes it one, and the rows that follow it; the line breaks around it belong to the table, so
 * writing the segments back one after the other gives the body again.
 */
export function splitTables(body: string): Segment[] {
  const lines = body.split("\n");
  const out: Segment[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length > 0) out.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  let i = 0;
  while (i < lines.length) {
    const head = cells(lines[i]);
    if (head && i + 1 < lines.length && isRule(lines[i + 1]) && cells(lines[i + 1])?.length === head.length) {
      flush();
      const rows = [head];
      i += 2;
      while (i < lines.length) {
        const row = cells(lines[i]);
        if (!row) break;
        rows.push(Array.from({ length: head.length }, (_, c) => row[c] ?? ""));
        i += 1;
      }
      out.push({ kind: "table", rows });
      continue;
    }
    text.push(lines[i]);
    i += 1;
  }
  flush();
  // A table ends its own last line, so a body that stops right after one has no text after it.
  const last = out[out.length - 1];
  if (last && last.kind === "text" && last.text === "" && out.length > 1) out.pop();
  return out;
}

/** What a spreadsheet puts on the clipboard: tab-separated cells, one row per line. Null for a single word. */
export function parseTsv(text: string): string[][] | null {
  const trimmed = text.replace(/\r/g, "").replace(/\n+$/, "");
  if (!/[\t\n]/.test(trimmed)) return null;
  return trimmed.split("\n").map((line) => line.split("\t"));
}
