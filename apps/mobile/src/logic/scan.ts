/**
 * A scanned document as the phone makes it: photos of its pages, each shrunk to 1600 px on its long
 * side, put one per A4 sheet (fitted, never cropped) in an HTML page that `expo-print` turns into a
 * PDF; and the name it is proposed under, from the hour.
 */

/** The size a page is saved at: at most `longSide` on its long side, its proportions kept. */
export function scanPageSize(width: number, height: number, longSide = 1600): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= longSide) return { width, height };
  const scale = longSide / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The document to print: one A4 sheet per page, the photo fitted in it. */
export function scanHtml(pages: { base64: string; width: number; height: number }[]): string {
  const style = [
    "@page { size: A4; margin: 0; }",
    "html, body { margin: 0; padding: 0; }",
    ".page { width: 210mm; height: 297mm; display: flex; align-items: center; justify-content: center; page-break-after: always; }",
    ".page:last-child { page-break-after: auto; }",
    "img { max-width: 100%; max-height: 100%; object-fit: contain; }",
  ].join(" ");
  const body = pages.map((p) => `<div class="page"><img src="data:image/jpeg;base64,${p.base64}" width="${p.width}" height="${p.height}" /></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8" /><style>${style}</style></head><body>${body}</body></html>`;
}

/** The name proposed for a scan made at `now`: the dictionary's words around the day and the time. */
export function scanName(now: Date, timeZone: string, say: (vars: Record<string, string>) => string): string {
  // Read, never shown: a fixed language keeps the digits and the 24-hour clock predictable.
  // i18n-audit-ignore-next-line
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return say({ day: part("day"), month: part("month"), year: part("year"), hour: part("hour"), minute: part("minute") });
}
