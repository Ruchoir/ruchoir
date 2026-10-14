import { test } from "node:test";
import assert from "node:assert/strict";

import { allTimeZones } from "../src/logic/timeZones.ts";

test("the_zones_are_listed_even_without_the_engine", () => {
  const supported = Intl.supportedValuesOf;
  // The phone's engine has no list to give: the app's own is used.
  (Intl as { supportedValuesOf: unknown }).supportedValuesOf = () => [];
  try {
    const zones = allTimeZones();
    assert.ok(zones.length > 300);
    for (const zone of ["Europe/Paris", "Europe/Warsaw", "America/New_York", "Asia/Tokyo"]) assert.ok(zones.includes(zone), zone);
  } finally {
    (Intl as { supportedValuesOf: unknown }).supportedValuesOf = supported;
  }
});
