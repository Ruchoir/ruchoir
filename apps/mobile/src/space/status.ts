import type { Workspace } from "@ruchoir/client";

/**
 * Where the person stands with spaces: still loading, in none at all (a new account, or one removed
 * from its last space), or in at least one. "None" has its own screen, not an endless spinner.
 */
export function spaceStatus(spaces: Workspace[] | undefined): "loading" | "none" | "ready" {
  if (!spaces) return "loading";
  return spaces.length ? "ready" : "none";
}
