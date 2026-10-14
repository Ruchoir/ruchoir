/**
 * What a screen shows of a load (`useLoad`): the result of its key; or, while a new key of the same
 * group loads (another view or period of the same space), the last result, so the screen does not
 * blink through its loading state. A key of another group (another space) never shows the last one.
 */
export type LoadResult<T> = { key: string; group?: string; data?: T; error?: { offline: boolean } };

export function shownResult<T>(
  result: LoadResult<T>,
  key: string | null,
  group: string | undefined,
): { data: T | undefined; error: { offline: boolean } | null; loading: boolean } {
  if (result.key === key) return { data: result.data, error: result.error ?? null, loading: result.data === undefined && !result.error };
  const kept = key !== null && group !== undefined && result.group === group ? result.data : undefined;
  return { data: kept, error: null, loading: key !== null };
}
