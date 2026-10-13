/**
 * The web's door to the API client.
 *
 * The client itself lives in `@ruchoir/client`, shared with the mobile app. The web uses its
 * defaults (same-origin relative calls, the session cookie) and only tells it which language the
 * interface speaks. What a browser alone can do, the WebAuthn ceremonies, stays here (`passkeys.ts`).
 */
import { configureClient } from "@ruchoir/client/config";
import { currentLocale } from "@/lib/i18n/current";

configureClient({ locale: currentLocale });

export * from "@ruchoir/client/api";
export { registerPasskey, verifyPasskey } from "./passkeys";
