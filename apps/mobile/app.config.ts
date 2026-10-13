import type { ExpoConfig } from "expo/config";

/**
 * The app's configuration. No `updates` URL: Ruchoir uses none of Expo's hosted services for what
 * it builds and ships (no EAS Build, Update or push), see `docs/adr/0005-native-apps.md`.
 *
 * One exception, for development only: Expo Go on a physical iPhone opens a project only when the
 * Expo CLI signs it, which takes an Expo project. Its id comes from the developer's untracked
 * `.env.local` (`EXPO_DEV_PROJECT_ID`) and never from the repository, so a build made without it
 * names no Expo project at all.
 */
const devProjectId = process.env.EXPO_DEV_PROJECT_ID?.trim();

const config: ExpoConfig = {
  name: "Ruchoir",
  slug: "ruchoir",
  scheme: "ruchoir",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.ruchoir.app",
    supportsTablet: false,
  },
  android: {
    package: "com.ruchoir.app",
    adaptiveIcon: { foregroundImage: "./assets/icon.png", backgroundColor: "#f6f7f9" },
  },
  plugins: ["expo-secure-store", "expo-font", "expo-localization", "expo-web-browser"],
  ...(devProjectId ? { extra: { eas: { projectId: devProjectId } } } : {}),
};

export default config;
