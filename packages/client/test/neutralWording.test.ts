// Run with `pnpm --filter @ruchoir/client test` (Node's own runner, types stripped by Node).
// Sentences about people never assume a gender (lot 7, ruling 18): in French, no masculine participle
// or "ceux qui" standing for a person. The two apps' French dictionaries are checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DICTIONARIES = [
  "../../../apps/web/lib/i18n/dictionaries/fr.json",
  "../../../apps/mobile/src/i18n/dictionaries/fr.json",
];

const GENDERED = new RegExp(
  [
    "prévenu|prévenue|ceux qui|celles qui|ceux et celles|celles et ceux|l'est la veille|connecté|\\(e\\)|\\(e?s\\)",
    "ceux (que|dont|qui)|celles|invitée|vous a invité|en invitée|le dernier propriétaire|dernier propriétaire",
    // "Vous êtes / avez été" + a participle that agrees with the person. The noun "invité" as a standing
    // name ("L'invité le reçoit la veille", "Invité jusqu'au") is not flagged: only these forms are.
    "vous (êtes|avez été|serez) (\\w+ )?(invité|retiré|connecté|ajouté|averti|prévenu|nommé|promu|rétrogradé|exclu|bloqué|inscrit|abonné)",
    "\\{\\{(who|name|actor|target)\\}\\} (a été|est|sera) (invité|retiré|ajouté|nommé|promu|rétrogradé|exclu|bloqué)",
    "(sera|seront) (retiré|ajouté)|^Retiré du canal",
  ].join("|"),
  "i",
);

function strings(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  }
}

for (const file of DICTIONARIES) {
  test(`no_gendered_sentence_in_${file.includes("/web/") ? "web" : "mobile"}_fr`, () => {
    const all: [string, string][] = [];
    strings(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), "", all);
    const offending = all.filter(([, text]) => GENDERED.test(text)).map(([key, text]) => `${key}: ${text}`);
    assert.deepEqual(offending, []);
  });
}
