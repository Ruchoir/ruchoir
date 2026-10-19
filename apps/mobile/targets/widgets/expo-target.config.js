/**
 * The iPhone's widgets (step 6e, mockup "Widgets iOS"): the agenda and the discussions, on the home
 * screen (small, medium, large) and the lock screen. They read the instance's address and the session
 * token from the keychain group the app shares (`push/phone.ts`) and ask the instance themselves.
 * Built into the app by @bacons/apple-targets at prebuild; bundle id com.ruchoir.app.widgets.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: "widget",
  name: "widgets",
  bundleIdentifier: ".widgets",
  deploymentTarget: "16.4",
  colors: {
    // The brand's terracotta for the buttons and accents; the app's canvas behind.
    $accent: "#c65d45",
    $widgetBackground: { light: "#f6f7f9", dark: "#15171c" },
    // Named for the Swift code (Color("canvas")…), the app's own tokens (src/theme/tokens.ts).
    canvas: { light: "#f6f7f9", dark: "#15171c" },
    card: { light: "#ffffff", dark: "#1e2128" },
    ink: { light: "#15171c", dark: "#f1f2f4" },
    muted: { light: "#6b717d", dark: "#9aa1ad" },
    brand: "#c65d45",
  },
  // The Ruchoir mark the widget mockups put in their heads, drawn as a template in the brand colour.
  // Relative to this folder, where the plugin resolves it.
  images: { mark: "../../assets/mark.png" },
  entitlements: {
    "keychain-access-groups": ["$(AppIdentifierPrefix)com.ruchoir.app.shared"],
  },
});
