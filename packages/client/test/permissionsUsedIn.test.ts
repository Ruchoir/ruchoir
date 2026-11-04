// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { usedInRows } from "../src/permissionsLogic/usedIn.ts";

test("a_deleted_group_or_role_refusal_lists_where_it_is_used", () => {
  const rows = usedInRows([
    { kind: "file", hidden: true },
    { kind: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3", name: "compta", hidden: false },
    { kind: "calendar", id: "3d7d566c-6a5f-5d71-a6c3-91a510dbea62", name: "Congés", hidden: false },
    { kind: "file", id: "e106010e-830a-53f1-854e-0d5b1635b305", name: "Devis.xlsx", hidden: false },
  ]);
  // Hidden places come last, whatever order they arrive in, and carry only their kind.
  assert.deepEqual(rows.map((r) => r.hidden), [false, false, false, true]);
  assert.deepEqual(rows[0], { kind: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3", label: "#compta", hidden: false, kindKey: "calendar.channel", levelKey: undefined, open: { type: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3" } });
  assert.equal(rows[1].label, "Congés");
  assert.equal(rows[2].kindKey, "access.usedIn.file");
  assert.deepEqual(rows[3], { kind: "file", id: undefined, label: undefined, hidden: true, kindKey: "access.usedIn.file", levelKey: undefined, open: undefined });
  assert.equal(usedInRows([]).length, 0);
  for (const locale of ["fr", "en", "de", "es", "it", "pl"]) {
    const dict = JSON.parse(readFileSync(new URL(`../../../apps/web/lib/i18n/dictionaries/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    for (const row of rows) assert.ok(row.kindKey.split(".").reduce<unknown>((at, p) => (at as Record<string, unknown> | undefined)?.[p], dict), `${locale}: ${row.kindKey}`);
  }
});

test("used_in_rows_show_the_level_and_open_the_place", () => {
  const rows = usedInRows([
    { kind: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3", name: "compta", hidden: false, level: "contribute" },
    { kind: "file", id: "e106010e-830a-53f1-854e-0d5b1635b305", name: "Devis.xlsx", hidden: false, level: "read", parentId: "bc5e52d5-e291-5282-9188-0d8c7ebd7ac8" },
    { kind: "file", id: "913e7294-5a58-506d-a726-90474ffaadd5", name: "Compta", hidden: false, level: "custom" },
    { kind: "calendar", id: "3d7d566c-6a5f-5d71-a6c3-91a510dbea62", name: "Congés", hidden: false, level: "manage" },
    { kind: "channel", hidden: true },
  ]);
  // The level reads with the words the access dialog uses for that kind of thing.
  assert.deepEqual(rows.map((r) => r.levelKey), ["access.level.channel.contribute", "access.level.read", "access.level.custom", "access.level.manage", undefined]);
  assert.equal(usedInRows([{ kind: "file", id: "9a49e33a-5efb-506c-97f9-a07f0242714f", name: "x", hidden: false, level: "contribute" }])[0].levelKey, "access.level.file.contribute");
  assert.equal(usedInRows([{ kind: "calendar", id: "6c0d05b2-3229-5271-af34-15698f45781b", name: "x", hidden: false, level: "contribute" }])[0].levelKey, "access.level.calendar.contribute");
  // A channel opens the channel; a file opens the files at its folder, the root when it has none;
  // a calendar opens the calendar. A hidden place opens nothing.
  assert.deepEqual(rows.map((r) => r.open), [
    { type: "channel", id: "b49f8860-af63-541d-a527-157ee6adbcd3" },
    { type: "files", folderId: "bc5e52d5-e291-5282-9188-0d8c7ebd7ac8" },
    { type: "files", folderId: undefined },
    { type: "calendar" },
    undefined,
  ]);
});
