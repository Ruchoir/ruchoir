/**
 * Customizable keyboard shortcuts for the app shell.
 *
 * A binding is stored as a normalized "chord" string, for example "Mod+K", "Mod+Shift+M",
 * "Alt+Shift+ArrowDown" or "?". "Mod" is the platform-primary modifier: Command on macOS,
 * Control everywhere else, so a single stored binding works across platforms. An empty string
 * means the command is unbound. Bindings live in the persisted settings, so they can be
 * customized in the preferences.
 */

export type ShortcutId =
  | "search"
  | "switcher"
  | "newMessage"
  | "nextUnread"
  | "prevUnread"
  | "markRead"
  | "help";

/** A binding per command. Missing or empty means the command has no shortcut. */
export type Bindings = Record<ShortcutId, string>;

export type CommandDef = {
  id: ShortcutId;
  /** French UI label. */
  label: string;
  /** Short description shown under the label. */
  hint: string;
  /** Factory-default chord. */
  defaultChord: string;
};

/**
 * The commands a keyboard shortcut can trigger, in the order shown in the preferences.
 * `markRead` deliberately defaults to Shift+Escape, not a bare Escape: a bare Escape is already
 * used everywhere to close dialogs, panels and menus, so binding a global action to it would
 * clash. Shift+Escape stays reachable without stealing the plain key.
 */
export const COMMANDS: CommandDef[] = [
  { id: "search", label: "Recherche globale", hint: "Chercher dans les messages, fichiers et personnes", defaultChord: "Mod+K" },
  { id: "switcher", label: "Aller à une conversation", hint: "Sauter vers un canal ou un message privé", defaultChord: "Mod+J" },
  { id: "newMessage", label: "Nouveau message", hint: "Démarrer un message privé", defaultChord: "Mod+Shift+M" },
  { id: "nextUnread", label: "Conversation non lue suivante", hint: "Passer à la conversation non lue suivante", defaultChord: "Alt+Shift+ArrowDown" },
  { id: "prevUnread", label: "Conversation non lue précédente", hint: "Revenir à la conversation non lue précédente", defaultChord: "Alt+Shift+ArrowUp" },
  { id: "markRead", label: "Marquer comme lu", hint: "Marquer la conversation ouverte comme lue", defaultChord: "Shift+Escape" },
  { id: "help", label: "Aide et raccourcis", hint: "Ouvrir le centre d'aide", defaultChord: "?" },
];

// No positional "switch to space N" command. Every modifier plus a digit is taken by some browser
// for its own tabs (Alt under Firefox on Linux, Ctrl under Chrome), and on an AZERTY keyboard the
// digit row needs Shift anyway, so the label would not match the key. Switching space goes through
// the rail or the quick switcher, which lists spaces.

export const DEFAULT_BINDINGS: Bindings = Object.fromEntries(
  COMMANDS.map((c) => [c.id, c.defaultChord]),
) as Bindings;

/** Merge a persisted value onto the defaults, keeping only known ids and string bindings. */
export function mergeBindings(raw: unknown): Bindings {
  const out = { ...DEFAULT_BINDINGS };
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const c of COMMANDS) {
      const v = rec[c.id];
      if (typeof v === "string") out[c.id] = v; // "" is a valid (unbound) value
    }
  }
  return out;
}

/** Normalize a single key name for a chord (letters upper-cased, space named). */
function normalizeKey(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return key; // ArrowDown, Escape, Enter, Tab, F-keys, etc.
}

/**
 * Turn a keydown into a normalized chord, or null for a lone modifier press.
 *
 * Modifier order is fixed (Mod, Alt, Shift) so equal chords always compare equal. Shift is
 * folded into the chord for named keys and letters (so Ctrl+Shift+M reads "Mod+Shift+M"), but
 * dropped for other printable characters, whose glyph already encodes the shift (so Shift+/ on a
 * standard layout reads "?", not "Shift+?").
 */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Meta" || key === "Alt" || key === "Shift") return null;

  const printable = key.length === 1;
  const alpha = printable && /[a-z]/i.test(key);

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && (!printable || alpha)) parts.push("Shift");
  parts.push(normalizeKey(key));
  return parts.join("+");
}

/** True on Apple platforms, so the display can use the Command/Option glyphs. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(p);
}

const NAMED_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Échap",
  Enter: "Entrée",
  Space: "Espace",
  Tab: "Tab",
  Backspace: "Retour arr.",
  Delete: "Suppr",
};

/** Human-readable form of a chord for a given platform (French labels, glyphs on macOS). */
export function formatChord(chord: string, mac: boolean = isMac()): string {
  if (!chord) return "";
  const sep = mac ? " " : " + ";
  return chord
    .split("+")
    .map((p) => {
      if (p === "Mod") return mac ? "⌘" : "Ctrl";
      if (p === "Alt") return mac ? "⌥" : "Alt";
      if (p === "Shift") return mac ? "⇧" : "Maj";
      return NAMED_LABELS[p] ?? p;
    })
    .join(sep);
}
