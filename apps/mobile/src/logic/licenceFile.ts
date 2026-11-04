/**
 * Checks on a licence before it is sent, and the numbers of its state card. A licence is one line of
 * text, so a file that is not text, is empty or is large is refused here with a sentence instead of
 * being sent (the server would refuse it too, but a phone should not read a photo as text). Pure, so
 * Node tests it.
 */

/** Anything bigger is not a licence (the web's own cap). */
export const LICENCE_MAX_BYTES = 64 * 1024;

const EXTENSIONS = new Set(["txt", "lic", "licence"]);

export type LicenceProblem = "type" | "size" | "empty" | "notText";

/** The bytes a string takes as UTF-8, without needing `TextEncoder`. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Why a licence text, pasted or read from a file, is not worth sending; `null` when it may go.
 * A picked file passes its `name` (and `mime`, `size` when the phone says them) and is also held to
 * its type; pasted text has no name and skips that one. Order: type, size, empty, text.
 */
export function checkLicence(input: { name?: string; mime?: string | null; size?: number; text: string }): LicenceProblem | null {
  const { name, mime, size, text } = input;
  if (name !== undefined) {
    const dot = name.lastIndexOf(".");
    const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    const plain = (mime ?? "").split(";")[0].trim().toLowerCase() === "text/plain";
    if (!EXTENSIONS.has(extension) && !plain) return "type";
  }
  if ((size ?? 0) > LICENCE_MAX_BYTES || utf8Length(text) > LICENCE_MAX_BYTES) return "size";
  if (text.trim() === "") return "empty";
  // A NUL byte, or the replacement character a binary file leaves when it is read as text.
  if (text.includes("\u0000") || text.includes("�")) return "notText";
  return null;
}

/** The share of the seats taken, for the bar: between 0 and 1, and `full` once none is left. */
export function seatsFraction(used: number, seats: number): { fraction: number; full: boolean } {
  const fraction = seats > 0 ? Math.min(1, Math.max(0, used / seats)) : 1;
  return { fraction, full: seats <= 0 || used >= seats };
}

/**
 * The size of a picked file, from what the picker and the file system say (the first usable one), or
 * `null` when neither does: such a file is refused, never read, since a big one would be read whole.
 */
export function knownFileSize(...sizes: (number | null | undefined)[]): number | null {
  for (const size of sizes) if (typeof size === "number" && Number.isFinite(size) && size >= 0) return size;
  return null;
}
