/** A feature as the screens read it: undefined while the instance has not said (not "no" yet), then yes or no. */
export function featureState(list: readonly string[] | undefined, feature: string): boolean | undefined {
  return list === undefined ? undefined : list.includes(feature);
}
