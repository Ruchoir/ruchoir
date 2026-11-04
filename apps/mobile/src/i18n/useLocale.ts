import { pickZone } from "@ruchoir/client/permissionsLogic";

import { useTranslation } from ".";
import { useSession } from "../session/SessionProvider";

/** The phone's own zone, the fallback when the account has none. */
const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The language and the zone dates are written in: the interface's, and the account's or the phone's.
 * The one zone of every date on the phone, guests' and licences' included (`pickZone`, shared with the web).
 */
export function useLocale(): { locale: string; timeZone: string } {
  const { i18n } = useTranslation();
  const { state } = useSession();
  const timeZone = pickZone(state.kind === "signedIn" ? state.user.timezone : undefined, DEVICE_ZONE);
  return { locale: i18n.language, timeZone };
}
