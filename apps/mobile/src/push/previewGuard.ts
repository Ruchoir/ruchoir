/**
 * Registering this phone for notifications writes to the session (`PUT` and `DELETE
 * /push/devices`), which a previewing session refuses. The client drops the automatic one in
 * silence, which would let the phone believe it is registered, so a person's own action is refused
 * here with a sentence, and a registration at launch simply leaves the previewing instance out.
 */
export class PreviewBlocked extends Error {
  constructor() {
    super("an instance is previewing a role");
    this.name = "PreviewBlocked";
  }
}

export function isPreviewBlocked(error: unknown): boolean {
  return error instanceof PreviewBlocked;
}

/** Refuse a person's action on the phone's notifications while any of these instances previews. */
export function requireNoPreview<T>(clients: T[], previewing: (client: T) => boolean): void {
  if (clients.some(previewing)) throw new PreviewBlocked();
}

/** The instances to register: all of them, unless one previews (refused when the person asked, else skipped). */
export function registrationTargets<T>(clients: T[], previewing: (client: T) => boolean, asked: boolean): T[] {
  if (asked) requireNoPreview(clients, previewing);
  return clients.filter((client) => !previewing(client));
}

/** Split instances into those a write may reach and those whose session is previewing a role. */
export function partitionByPreview<T>(items: T[], previewing: (item: T) => boolean): { free: T[]; previewing: T[] } {
  return { free: items.filter((item) => !previewing(item)), previewing: items.filter(previewing) };
}
