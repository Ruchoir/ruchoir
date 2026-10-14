/**
 * The calendar's pure logic, shared by the web and the apps: time in a zone, recurrence rules and
 * their words, reminders and their words. Kept out of the package's root index, where some of its
 * short names (`addDays`, `Translate`) would read as the whole client's.
 */
export * from "./time.ts";
export * from "./rule.ts";
export * from "./rulePhrase.ts";
export * from "./reminders.ts";
