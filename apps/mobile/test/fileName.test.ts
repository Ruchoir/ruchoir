import { test } from "node:test";
import assert from "node:assert/strict";

import { pickedName } from "../src/logic/fileName.ts";

test("a_doubled_extension_is_said_once", () => {
  assert.equal(pickedName("Bulletin_08_2026.pdf.pdf"), "Bulletin_08_2026.pdf");
  assert.equal(pickedName("photo.JPG.jpg"), "photo.jpg");
});

test("other_names_stay_as_they_are", () => {
  assert.equal(pickedName("archive.tar.gz"), "archive.tar.gz");
  assert.equal(pickedName("Devis client.pdf"), "Devis client.pdf");
  assert.equal(pickedName("notes"), "notes");
  assert.equal(pickedName(".env"), ".env");
});
