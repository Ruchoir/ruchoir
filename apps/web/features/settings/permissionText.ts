import type { TranslationKey } from "@/lib/i18n";
import { FAMILY_TEXT as SHARED_FAMILY_TEXT, PERMISSION_TEXT as SHARED_PERMISSION_TEXT } from "@ruchoir/client/permissionsLogic";

/** The catalogue in plain words, shared with the apps (`@ruchoir/client/permissionsLogic`), typed with the web's keys. */
export const PERMISSION_TEXT = SHARED_PERMISSION_TEXT as unknown as Record<string, { title: TranslationKey; desc: TranslationKey }>;

/** The four families' names, in the editor's order. */
export const FAMILY_TEXT = SHARED_FAMILY_TEXT as unknown as Record<"space" | "channels" | "files" | "calendars", TranslationKey>;
