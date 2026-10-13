import type { ExpoConfig } from "expo/config";

/**
 * The app's configuration. No `extra.eas.projectId` and no `updates` URL: Ruchoir uses none of
 * Expo's hosted services (no EAS Build, Update or push), see `docs/adr/0005-native-apps.md`.
 */
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
};

export default config;
