import { test } from "node:test";
import assert from "node:assert/strict";

import { downloadName } from "./downloadName.ts";

test("a_download_keeps_the_links_own_name_else_its_last_part", () => {
  assert.equal(downloadName("/api/v1/files/a/download", "Devis 2026.pdf"), "Devis 2026.pdf");
  assert.equal(downloadName("/api/v1/files/a/Devis%202026.pdf", ""), "Devis 2026.pdf");
  assert.equal(downloadName("/api/v1/calendar/print?view=week", "  "), "print");
  assert.equal(downloadName("/", null), "download");
  assert.equal(downloadName("/api/v1/files/%E0%A4%A", undefined), "download");
});
