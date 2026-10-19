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
  // Given by the build workflow only: the Apple team the extensions are made for, and the Firebase
  // project's file Android needs to receive pushes (ADR 0006).
  const appleTeamId = env.APPLE_TEAM_ID?.trim() || undefined;
  const googleServicesFile = env.GOOGLE_SERVICES_FILE?.trim() || undefined;
  return {
    name: "Ruchoir",
    slug: "ruchoir",
    scheme: "ruchoir",
    version: "0.1.0",
    // Every orientation for tablets (an iPad app must take all four); phones are held upright at
    // launch (src/App.tsx).
    orientation: "default",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: "com.ruchoir.app",
      supportsTablet: true,
      ...(build ? { buildNumber: String(build) } : {}),
      // HTTPS and the system's cryptography only, so App Store Connect does not ask about export
      // compliance for every build.
      config: { usesNonExemptEncryption: false },
      ...(appleTeamId ? { appleTeamId } : {}),
      entitlements: {
        // Shared with the notification extension (`targets/notifications`), which reads the
        // instance and the session token there to show what a push is about (ADR 0006).
        "keychain-access-groups": ["$(AppIdentifierPrefix)com.ruchoir.app.shared"],
      },
    },
    android: {
      package: "com.ruchoir.app",
      ...(build ? { versionCode: build } : {}),
      ...(googleServicesFile ? { googleServicesFile } : {}),
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
      // Phone notifications (ADR 0006): every build is signed for the App Store (TestFlight too).
      ["expo-notifications", { mode: "production", icon: "./assets/notification-icon.png", color: "#c65d45" }],
      // The iPhone extensions written in Swift, under targets/ (the notification service).
      "@bacons/apple-targets",
      // No `fetch` background mode on the iPhone, which the task manager adds and nothing uses.
      "./plugins/no-background-fetch",
      // The Android widgets (src/widgets/android.tsx), drawn every half hour and when placed.
      [
        "react-native-android-widget",
        {
          widgets: [
            {
              name: "RuchoirAgenda",
              label: "Prochain",
              description: "Le prochain rendez-vous",
              minWidth: "110dp",
              minHeight: "110dp",
              targetCellWidth: 2,
              targetCellHeight: 2,
              resizeMode: "horizontal|vertical",
              updatePeriodMillis: 1_800_000,
            },
            {
              name: "RuchoirDiscussions",
              label: "Discussions",
              description: "Les dernières conversations",
              minWidth: "250dp",
              minHeight: "110dp",
              targetCellWidth: 4,
              targetCellHeight: 2,
              resizeMode: "horizontal|vertical",
              updatePeriodMillis: 1_800_000,
            },
            {
              name: "RuchoirShortcuts",
              label: "Raccourcis",
              description: "Message, événement, fichier, recherche",
              minWidth: "250dp",
              minHeight: "40dp",
              targetCellWidth: 4,
              targetCellHeight: 1,
              resizeMode: "horizontal",
            },
            {
              name: "RuchoirReply",
              label: "À répondre",
              description: "Qui attend une réponse",
              minWidth: "110dp",
              minHeight: "110dp",
              targetCellWidth: 2,
              targetCellHeight: 2,
              resizeMode: "horizontal|vertical",
              updatePeriodMillis: 1_800_000,
            },
          ],
        },
      ],
      // The Face ID lock (Security): the prompt's reason, in the six languages, comes from locales/.
      ["expo-local-authentication", { faceIDPermission: "Ruchoir uses Face ID to unlock, when you have turned the lock on." }],
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
