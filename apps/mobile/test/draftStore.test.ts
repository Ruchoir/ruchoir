import { test } from "node:test";
import assert from "node:assert/strict";

import { closeDraft, openDraft, readDraft, subscribeDraft, updateDraft } from "../src/screens/agenda/form/draftStore.ts";
import { newDraft } from "../src/logic/eventForm.ts";

const base = () => newDraft({ day: "2026-10-20", now: new Date("2026-10-14T08:00:00Z"), timeZone: "Europe/Paris", calendars: [] });

test("draft_survives_until_closed", () => {
  openDraft("f1", base());
  updateDraft("f1", (d) => ({ ...d, title: "Visite" }));
  assert.equal(readDraft("f1")?.title, "Visite");
  closeDraft("f1");
  assert.equal(readDraft("f1"), undefined);
  // A change to a closed form is dropped, not revived.
  updateDraft("f1", (d) => ({ ...d, title: "Trop tard" }));
  assert.equal(readDraft("f1"), undefined);
});

test("update_notifies_listeners", () => {
  openDraft("f2", base());
  let heard = 0;
  const stop = subscribeDraft("f2", () => heard++);
  updateDraft("f2", (d) => ({ ...d, location: "Salle Atlas" }));
  updateDraft("other", (d) => d);
  stop();
  updateDraft("f2", (d) => ({ ...d, location: "Ailleurs" }));
  assert.equal(heard, 1);
  closeDraft("f2");
});
