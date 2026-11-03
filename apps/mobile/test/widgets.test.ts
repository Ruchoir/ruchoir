import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { palette, VARIANTS } from "../src/theme/tokens.ts";
import { initials, mixHex, previewOf, startsIn, unreadTotal, upcoming, widgetPalette } from "../src/widgets/data.ts";

const now = new Date("2026-10-15T08:00:00Z");
const at = (iso: string, title: string, end = "2026-10-15T23:00:00Z") => ({ title, all_day: false, start: iso, end });

test("the_next_events_are_those_not_over_yet_soonest_first", () => {
  const events = upcoming(
    [at("2026-10-15T14:00:00Z", "Later"), { title: "Over", all_day: false, start: "2026-10-15T06:00:00Z", end: "2026-10-15T07:00:00Z" }, at("2026-10-15T09:00:00Z", "Soon")],
    now,
    5,
  );
  assert.deepEqual(events.map((e) => e.title), ["Soon", "Later"]);
  assert.equal(upcoming([at("2026-10-15T09:00:00Z", "A"), at("2026-10-15T10:00:00Z", "B")], now, 1).length, 1);
});

test("an_event_says_when_it_starts", () => {
  assert.deepEqual(startsIn(new Date("2026-10-15T07:30:00Z"), now), { kind: "now" });
  assert.deepEqual(startsIn(new Date("2026-10-15T08:20:00Z"), now), { kind: "minutes", n: 20 });
  assert.deepEqual(startsIn(new Date("2026-10-15T10:05:00Z"), now), { kind: "hours", n: 2 });
  assert.deepEqual(startsIn(new Date("2026-10-17T10:00:00Z"), now), { kind: "later" });
});

test("the_unread_messages_of_every_space_add_up", () => {
  assert.equal(unreadTotal([{ unread: 3 }, { unread: 0 }, {}, { unread: 4 }]), 7);
  assert.equal(unreadTotal([]), 0);
});

test("widgets_follow_the_apps_theme", () => {
  const night = widgetPalette("violet-dark", false);
  assert.equal(night.dark, true);
  assert.equal(night.acc, "#c9a8ff");
  const day = widgetPalette("mint", true);
  assert.equal(day.dark, false);
  assert.equal(day.acc, "#6fe0c2");
  // No theme shared yet: the phone's own day or night, the sky accent.
  assert.equal(widgetPalette(null, true).dark, true);
  assert.equal(widgetPalette(null, true).acc, "#8fd0ff");
  assert.equal(mixHex("#ffffff", "#000000", 0.5), "#808080");
});

test("a_rows_preview_says_who_spoke", () => {
  const said = (who: string, text: string) => `${who} : ${text}`;
  assert.equal(previewOf({ excerpt: "Salut", mine: false, created_at: "", author: "Léa Martin" }, "Vous", said), "Léa : Salut");
  assert.equal(previewOf({ excerpt: "Salut", mine: true, created_at: "" }, "Vous", said), "Vous : Salut");
  assert.equal(previewOf({ excerpt: "Alice a rejoint", mine: false, created_at: "", system_event: "channel_joined" }, "Vous", said), "Alice a rejoint");
  assert.equal(initials("Léa Martin"), "LM");
  assert.equal(initials("Équipe"), "É");
});

test("widgets_take_the_variants_colours", () => {
  for (const v of VARIANTS) {
    for (const [theme, dark] of [["violet", false], ["violet-dark", true]] as const) {
      const p = palette(v, "violet", dark);
      const w = widgetPalette(theme, !dark, v);
      assert.equal(w.dark, dark, `${v} ${theme}`);
      assert.deepEqual(
        { acc: w.acc, surface: w.surface, strong: w.strong, body: w.body, muted: w.muted, line: w.line },
        { acc: p.acc, surface: p.surface, strong: p.ink, body: p.body, muted: p.muted, line: p.lineStrong },
        `${v} ${theme}`,
      );
    }
  }
  // The app forced into night while the phone is in day: the widgets follow the app.
  const marine = widgetPalette("marine-dark", false, "marine");
  assert.equal(marine.dark, true);
  assert.equal(marine.surface, palette("marine", "sky", true).surface);
});

test("an_unknown_style_keeps_the_accent_colours", () => {
  for (const style of ["bogus", null, "ruchoir"]) {
    assert.deepEqual(widgetPalette("mint-dark", false, style), widgetPalette("mint-dark", false), String(style));
  }
});

test("the_widget_extension_knows_the_same_colours", () => {
  const swift = readFileSync(new URL("../targets/widgets/Shared.swift", import.meta.url), "utf8");
  const hex = (n: string) => `#${n.toLowerCase()}`;
  for (const v of VARIANTS) {
    for (const dark of [false, true]) {
      const row = swift.match(new RegExp(`"${v}-${dark ? "night" : "day"}": Shades\\(([^)]*)\\)`));
      assert.ok(row, `no ${v} ${dark ? "night" : "day"} row in Shared.swift`);
      const values = Object.fromEntries([...row[1].matchAll(/(\w+): 0x([0-9A-Fa-f]{6})/g)].map((m) => [m[1], hex(m[2])]));
      const p = palette(v, "sky", dark);
      assert.deepEqual(values, { acc: p.acc, surface: p.surface, strong: p.ink, body: p.body, muted: p.muted, line: p.line }, `${v} ${dark}`);
    }
  }
});

test("the_widget_look_reads_its_style_before_capturing_itself", () => {
  // Swift refuses a closure that reads `self.dark` before every stored property of `Look` is set.
  const swift = readFileSync(new URL("../targets/widgets/Shared.swift", import.meta.url), "utf8");
  const line = swift.split("\n").find((l) => l.includes("shades = Instance.style"));
  assert.ok(line, "no shades assignment in Look.init");
  assert.doesNotMatch(line, /\bdark\b/);
});
