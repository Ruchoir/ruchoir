import { test } from "node:test";
import assert from "node:assert/strict";

import { scanHtml, scanName, scanPageSize } from "../src/logic/scan.ts";

test("pages_shrink_to_1600_on_their_long_side", () => {
  assert.deepEqual(scanPageSize(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(scanPageSize(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(scanPageSize(1200, 900), { width: 1200, height: 900 });
});

test("pages_fit_a4", () => {
  const html = scanHtml([
    { base64: "AAA", width: 1200, height: 1600 },
    { base64: "BBB", width: 1600, height: 1200 },
  ]);
  assert.equal(html.match(/<img /g)?.length, 2);
  assert.ok(html.includes("data:image/jpeg;base64,AAA"));
  assert.ok(html.includes("size: A4"));
  assert.ok(html.includes("object-fit: contain"));
  // Each page on its own sheet, the last one without a blank sheet after it.
  assert.ok(html.includes("page-break-after: always"));
  assert.ok(html.includes(".page:last-child { page-break-after: auto; }"));
});

test("scan_name_says_when", () => {
  const fr = (v: Record<string, string>) => `Scan ${v.day}-${v.month}-${v.year} ${v.hour}h${v.minute}`;
  // 13:40 UTC is 15:40 in Paris in October.
  assert.equal(scanName(new Date("2026-10-14T13:40:00Z"), "Europe/Paris", fr), "Scan 14-10-2026 15h40");
  assert.equal(scanName(new Date("2026-01-05T08:05:00Z"), "Europe/Paris", fr), "Scan 05-01-2026 09h05");
});
