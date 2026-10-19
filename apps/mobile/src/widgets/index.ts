/**
 * The Android widgets' door (`widgets/android.tsx`), opened only where their native module is
 * present: react-native-android-widget asks for it as soon as it is loaded, which throws in Expo Go.
 * On an iPhone the widgets are Swift (`targets/widgets`) and nothing here runs.
 */
import { Platform, TurboModuleRegistry } from "react-native";

type AndroidWidgets = typeof import("./android");

function load(): AndroidWidgets | null {
  if (Platform.OS !== "android" || TurboModuleRegistry.get("AndroidWidget") == null) return null;
  // Required here rather than imported, for the reason above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./android") as AndroidWidgets;
}

/** Register the task Android draws the widgets with; at the entry, before anything else runs. */
export function registerWidgets(): void {
  const widgets = load();
  if (!widgets) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registerWidgetTaskHandler } = require("react-native-android-widget") as typeof import("react-native-android-widget");
  registerWidgetTaskHandler(widgets.widgetTaskHandler);
}

/** Draw every placed widget again (signed in, signed out). */
export async function refreshWidgets(): Promise<void> {
  await load()?.refreshWidgets();
}
