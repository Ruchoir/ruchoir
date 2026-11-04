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
    // "ceux" / "celles" standing for people, anywhere: say "les personnes", "Seules les personnes listées".
    "\\bceux\\b|\\bcelles\\b",
    "ceux (que|dont|qui)|celles|invitée|vous a invité|en invitée|le dernier propriétaire|dernier propriétaire",
    // "Vous êtes / avez été" + a participle that agrees with the person. The noun "invité" as a standing
    // name ("L'invité le reçoit la veille", "Invité jusqu'au") is not flagged: only these forms are.
    "vous (êtes|avez été|serez) (\\w+ )?(invité|retiré|connecté|ajouté|averti|prévenu|nommé|promu|rétrogradé|exclu|bloqué|inscrit|abonné)",
    "\\{\\{(who|name|actor|target)\\}\\} (a été|est|sera) (invité|retiré|ajouté|nommé|promu|rétrogradé|exclu|bloqué)",
    "(sera|seront) (retiré|ajouté)|^Retiré du canal",
  ].join("|"),
  "i",
);

// A pronoun standing for a person ("tant qu'il n'a pas ouvert", "celui qu'il a", "elle a") says a gender:
// write "la personne", "le mot de passe actuel", or turn the sentence round. Impersonal forms, and
// the ones that stand for a thing, are not about anyone and are listed here by name: nothing else passes.
const PRONOUN = /qu['’](il|elle)s? |\b(il|elle)s? a\b/i;
const IMPERSONAL = ["il faut", "il y a", "il reste", "il suffit", "il s'agit", "s'il vous plaît"];
// Pronouns standing for a thing (a code, a link, a licence, a group, a file list, a space), never a person.
const THINGS = [
  "ou il a expiré",
  "ou il a déjà été utilisé",
  "il a peut-être expiré",
  "qu'il a été copié",
  "qu'elle a été émise",
  "elle a été émise",
  "quand elle a le focus",
  "jusqu'à ce qu'elle soit vidée",
  "tant qu'il y est",
  "tant qu'il est public",
  "ce qu'il contient",
  "tel qu'il était",
  "les rôles qu'il porte",
  "qu'elle affiche",
  "qu'elle atteint",
  "il n'a pas de responsable",
];

function strings(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  }
}

const pronounHits = (text: string) => {
  let rest = text;
  for (const ok of [...IMPERSONAL, ...THINGS]) rest = rest.replaceAll(new RegExp(ok.replace(/'/g, "['’]"), "gi"), " ");
  return PRONOUN.test(rest);
};

for (const file of DICTIONARIES) {
  test(`no_gendered_sentence_in_${file.includes("/web/") ? "web" : "mobile"}_fr`, () => {
    const all: [string, string][] = [];
    strings(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), "", all);
    const offending = all.filter(([, text]) => GENDERED.test(text)).map(([key, text]) => `${key}: ${text}`);
    assert.deepEqual(offending, []);
  });
  test(`no_gendered_pronoun_for_a_person_in_${file.includes("/web/") ? "web" : "mobile"}_fr`, () => {
    const all: [string, string][] = [];
    strings(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")), "", all);
    const offending = all.filter(([, text]) => pronounHits(text)).map(([key, text]) => `${key}: ${text}`);
    assert.deepEqual(offending, []);
  });
}
