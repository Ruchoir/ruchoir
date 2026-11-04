import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { usedInRows } from "./usedInLogic.ts";

test("a_deleted_group_or_role_refusal_lists_where_it_is_used", () => {
  const rows = usedInRows([
    { kind: "file", hidden: true },
    { kind: "channel", id: "c1", name: "compta", hidden: false },
    { kind: "calendar", id: "k1", name: "Congés", hidden: false },
    { kind: "file", id: "f1", name: "Devis.xlsx", hidden: false },
  ]);
  // Hidden places come last, whatever order they arrive in, and carry only their kind.
  assert.deepEqual(rows.map((r) => r.hidden), [false, false, false, true]);
  assert.deepEqual(rows[0], { kind: "channel", id: "c1", label: "#compta", hidden: false, kindKey: "calendar.channel" });
  assert.equal(rows[1].label, "Congés");
  assert.equal(rows[2].kindKey, "access.usedIn.file");
  assert.deepEqual(rows[3], { kind: "file", id: undefined, label: undefined, hidden: true, kindKey: "access.usedIn.file" });
  assert.equal(usedInRows([]).length, 0);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    for (const row of rows) assert.ok(row.kindKey.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict), `${locale}: ${row.kindKey}`);
  }
});
