import type { Translate } from "@ruchoir/client/calendarLogic";
import { useCallback } from "react";

import { useTranslation, type DictKey } from "./index";

/**
 * `t` for the calendar logic shared with the web (`@ruchoir/client/calendarLogic`), which names its
 * keys as plain strings (`calendar.rule.weekly`): they are in this app's dictionaries too.
 */
export function useSharedT(): Translate {
  const { t } = useTranslation();
  return useCallback((key: string, vars?: Record<string, string | number>) => String(t(key as DictKey, vars as never)), [t]);
}
