import type { ExpoConfig } from "expo/config";

type Env = Record<string, string | undefined>;

/**
 * The build number Apple and Google see (`CFBundleVersion`, `versionCode`): the build workflow's run
 * number (`.github/workflows/mobile-build.yml`), so each upload is above the last. Absent outside a
 * build, where nothing is uploaded.
 */
function buildNumber(env: Env): number | undefined {
  const raw = env.RUCHOIR_BUILD_NUMBER;
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`RUCHOIR_BUILD_NUMBER must be a positive whole number, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * The app's configuration. No `updates` URL: Ruchoir uses none of Expo's hosted services for what
 * it builds and ships (no EAS Build, Update or push), see `docs/adr/0005-native-apps.md`.
 *
 * One exception, for development only: Expo Go on a physical iPhone opens a project only when the
 * Expo CLI signs it, which takes an Expo project. Its id comes from the developer's untracked
 * `.env.local` (`EXPO_DEV_PROJECT_ID`) and never from the repository, so a build made without it
 * names no Expo project at all.
 */
export function appConfig(env: Env): ExpoConfig {
  const devProjectId = env.EXPO_DEV_PROJECT_ID?.trim();
  const build = buildNumber(env);
  return {
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
      ...(build ? { buildNumber: String(build) } : {}),
      // HTTPS and the system's cryptography only, so App Store Connect does not ask about export
      // compliance for every build.
      config: { usesNonExemptEncryption: false },
    },
    android: {
      package: "com.ruchoir.app",
      ...(build ? { versionCode: build } : {}),
      adaptiveIcon: {
        foregroundImage: "./assets/icon.png",
        backgroundColor: "#f6f7f9",
      },
    },
    plugins: [
      "expo-secure-store",
      "expo-font",
      "expo-localization",
      "expo-web-browser",
      // Photos are picked through the system picker and the camera takes stills only: no microphone.
      [
        "expo-image-picker",
        {
          cameraPermission: "Ruchoir uses the camera so you can send a photo in a message.",
          photosPermission: "Ruchoir opens your photos so you can attach them to a message.",
          microphonePermission: false,
        },
      ],
    ],
    // The permission prompts in the six languages of the interface (iOS reads them per language).
    locales: {
      fr: "./locales/fr.json",
      en: "./locales/en.json",
      es: "./locales/es.json",
      de: "./locales/de.json",
      it: "./locales/it.json",
      pl: "./locales/pl.json",
    },
    ...(devProjectId ? { extra: { eas: { projectId: devProjectId } } } : {}),
  };
}

export default appConfig(process.env);
