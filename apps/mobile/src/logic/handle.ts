/**
 * The name a new channel will carry, shown as it is typed: the server keeps a handle, not free text
 * (lower case, accents folded, anything else a single dash), so "Projets clients" becomes
 * `#projets-clients`. A copy of `apps/api/src/messaging/slug.rs`, case for case.
 */

export const MAX_HANDLE_LEN = 64;

const FOLD: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a",
  æ: "ae",
  ç: "c",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ñ: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o",
  œ: "oe",
  ù: "u", ú: "u", û: "u", ü: "u",
  ý: "y", ÿ: "y",
};

export function channelHandle(input: string): string {
  let out = "";
  let pendingDash = false;
  for (const raw of input.trim()) {
    const lower = raw.toLowerCase()[0] ?? raw;
    for (const ch of FOLD[lower] ?? lower) {
      if (/^[a-z0-9]$/.test(ch)) {
        if (pendingDash && out.length > 0) out += "-";
        pendingDash = false;
        out += ch;
        if (out.length >= MAX_HANDLE_LEN) return out;
      } else {
        pendingDash = true;
      }
    }
  }
  return out;
}
