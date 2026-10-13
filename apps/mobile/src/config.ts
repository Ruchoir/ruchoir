/**
 * Build-time settings of the app.
 *
 * `EXPO_PUBLIC_DEFAULT_SERVER` names the instance the server screen offers first. It comes from
 * `apps/mobile/.env.local`, which is never committed: no deployment hostname belongs in the
 * repository. Without it, the person types their instance's address.
 */
export const DEFAULT_SERVER: string | null = process.env.EXPO_PUBLIC_DEFAULT_SERVER?.trim() || null;
