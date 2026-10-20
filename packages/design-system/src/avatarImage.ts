import { Avatar, Style } from "@dicebear/core";
import blobsDef from "@dicebear/styles/blobs.json";
import cameoDef from "@dicebear/styles/cameo.json";
import gazeDef from "@dicebear/styles/gaze.json";

/**
 * Default avatars, generated locally with DiceBear (EU-authored, MIT + per-style licenses),
 * preset with the Ruchoir palette. Seeded by name, so each subject gets a stable, distinct
 * avatar (deterministic, not re-randomized per render). Generated client-side as a data URI,
 * no remote request (sovereignty). Styles per subject:
 *   - person    -> "shadows"
 *   - bot       -> "gaze"
 *   - workspace -> "blobs"
 */
export type AvatarKind = "person" | "bot" | "workspace";

/**
 * Backgrounds per subject (hex, no leading #). Lively pastels; never red for people, since
 * terracotta is the single brand accent and must not read as an avatar colour. Workspaces get a
 * full pastel rainbow since they are distinct org marks.
 */
const BACKGROUND: Record<AvatarKind, string[]> = {
  // Cool, saturated pastels that keep strong contrast with the (warm) cameo faces; no skin-adjacent
  // peach/pink (would blend), no red (brand accent).
  person: ["7cc0f0", "6fe0c2", "ffd84d", "b592f0", "56d8d4", "8fd98f"],
  // Distinct from people, keeps contrast with the dark gaze eyes.
  bot: ["56d8d4", "7cc0f0", "b592f0"],
  workspace: ["ffb3ba", "ffdfba", "ffe680", "8fe6a3", "8fd0ff", "c9a8ff", "f5b0f0"],
};

const STYLES: Record<AvatarKind, Style<any>> = {
  person: new Style(cameoDef as never),
  bot: new Style(gazeDef as never),
  workspace: new Style(blobsDef as never),
};

const cache = new Map<string, string>();

export function avatarDataUri(seed: string, kind: AvatarKind = "person"): string {
  const s = seed || "ruchoir";
  const key = `${kind}:${s}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const svg = new Avatar(STYLES[kind], { seed: s, backgroundColor: BACKGROUND[kind] }).toString();
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}

/**
 * The same default avatar, base64-encoded: for a consumer that writes it into a bare CSS `url(...)`
 * (the office editor does), where the parentheses and quotes of a plain data URI would break.
 */
export function avatarBase64Uri(seed: string, kind: AvatarKind = "person"): string {
  const svg = decodeURIComponent(avatarDataUri(seed, kind).slice("data:image/svg+xml;utf8,".length));
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
