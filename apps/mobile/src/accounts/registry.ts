/**
 * The instances the phone knows, as a plain value so it can be tested without a phone (ADR 0007).
 *
 * Each instance has a random `id` (what the Keychain entries and the scopes are named after) and its
 * origin. `active` is the instance whose space is open; `lastSpace` remembers, per instance, the
 * space opened last, so coming back to an instance lands where it was left. No secret lives here:
 * the session tokens have their own Keychain entries (`store.ts`).
 */

export type InstanceEntry = { id: string; origin: string };

export type Registry = {
  instances: InstanceEntry[];
  active: string | null;
  lastSpace: Record<string, string>;
};

export const EMPTY_REGISTRY: Registry = { instances: [], active: null, lastSpace: {} };

/** The instance at `origin`, if the phone knows it. */
export function findByOrigin(registry: Registry, origin: string): InstanceEntry | undefined {
  return registry.instances.find((entry) => entry.origin === origin);
}

/** Add an instance at the end of the list and make it active; one already known is only activated. */
export function addInstance(registry: Registry, entry: InstanceEntry): Registry {
  const known = findByOrigin(registry, entry.origin);
  if (known) return { ...registry, active: known.id };
  return { ...registry, instances: [...registry.instances, entry], active: entry.id };
}

/**
 * Forget an instance. When it was the active one, the next in the list takes its place (or the one
 * before it, for the last), so the app keeps showing something.
 */
export function removeInstance(registry: Registry, id: string): Registry {
  const index = registry.instances.findIndex((entry) => entry.id === id);
  if (index < 0) return registry;
  const instances = registry.instances.filter((entry) => entry.id !== id);
  const { [id]: _gone, ...lastSpace } = registry.lastSpace;
  const active = registry.active === id ? (instances[index] ?? instances[index - 1] ?? null)?.id ?? null : registry.active;
  return { instances, active, lastSpace };
}

export function setActive(registry: Registry, id: string): Registry {
  return registry.instances.some((entry) => entry.id === id) ? { ...registry, active: id } : registry;
}

export function setLastSpace(registry: Registry, id: string, spaceId: string): Registry {
  return { ...registry, lastSpace: { ...registry.lastSpace, [id]: spaceId } };
}

/**
 * The single-instance version's memory (ADR 0005): an instance, perhaps a token, perhaps the space
 * last opened, become the first entry of the registry, so an update asks nobody to sign in again.
 */
export function migrateLegacy(server: string, space: string | null, id: string): Registry {
  return { instances: [{ id, origin: server }], active: id, lastSpace: space ? { [id]: space } : {} };
}

/** A registry read back from the Keychain, or the empty one when it is missing or damaged. */
export function parseRegistry(json: string | null): Registry {
  if (!json) return EMPTY_REGISTRY;
  try {
    const value = JSON.parse(json) as Partial<Registry>;
    const instances = Array.isArray(value.instances)
      ? value.instances.filter((e): e is InstanceEntry => typeof e?.id === "string" && typeof e?.origin === "string")
      : [];
    const active = instances.some((e) => e.id === value.active) ? (value.active as string) : (instances[0]?.id ?? null);
    const lastSpace = value.lastSpace && typeof value.lastSpace === "object" ? value.lastSpace : {};
    return { instances, active, lastSpace };
  } catch {
    return EMPTY_REGISTRY;
  }
}
