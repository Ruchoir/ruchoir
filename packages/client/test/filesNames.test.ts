// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTaken, uniqueName } from "../src/filesLogic/names.ts";

test("a taken name gets the first free number before its extension", () => {
  assert.equal(uniqueName("Facture.pdf", ["Facture.pdf"]), "Facture (1).pdf");
  assert.equal(uniqueName("Facture.pdf", ["Facture.pdf", "Facture (1).pdf"]), "Facture (2).pdf");
  assert.equal(uniqueName("Facture.pdf", ["Budget.xlsx"]), "Facture.pdf");
  assert.equal(uniqueName("Notes", ["Notes"]), "Notes (1)");
  assert.equal(uniqueName("archive.tar.gz", ["archive.tar.gz"]), "archive.tar (1).gz");
  assert.equal(uniqueName(".env", [".env"]), ".env (1)");
});

test("names are compared without case, as the people sending them do", () => {
  assert.equal(isTaken("facture.PDF", ["Facture.pdf"]), true);
  assert.equal(uniqueName("facture.pdf", ["Facture.pdf"]), "facture (1).pdf");
});
