/**
 * What the widgets need from the app besides the session (`push/phone.ts`): the space on screen,
 * whose conversations they list, and the theme chosen in the app ("violet-dark"), which they follow
 * as the widget mockups ask. Written in the keychain group the extensions share, read by
 * `targets/widgets` on the iPhone and `widgets/android.tsx` on Android.
 */
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";

import { usePrefs } from "../prefs/store";
import { SHARED } from "../push/phone";
import { useSpace } from "../space/SpaceProvider";
import { themeName } from "../theme/tokens";
import { useTheme } from "../theme/useTheme";
import { refreshWidgets } from "./index";

import { SHARED_SPACE, SHARED_THEME } from "./keys";

/** Keep the widgets' space and theme in step with the app's. Mounted once, signed in. */
export function useWidgetLook(): void {
  const { current } = useSpace();
  const { accent } = usePrefs();
  const { dark } = useTheme();
  const theme = themeName(accent, dark);
  const space = current?.id;
  const written = useRef("");
  useEffect(() => {
    if (!space) return;
    const now = `${space}|${theme}`;
    if (written.current === now) return;
    written.current = now;
    void Promise.all([SecureStore.setItemAsync(SHARED_SPACE, space, SHARED), SecureStore.setItemAsync(SHARED_THEME, theme, SHARED)])
      .then(() => refreshWidgets())
      .catch(() => {
        written.current = "";
      });
  }, [space, theme]);
}
