/**
 * The iPhone's Notification Service Extension (ADR 0006): it receives each push before it is shown
 * (`mutable-content`), asks the instance what it is about, and shows that instead of the placeholder.
 * Built into the app by @bacons/apple-targets at prebuild; its bundle id is com.ruchoir.app.notifications.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: "notification-service",
  name: "notifications",
  bundleIdentifier: ".notifications",
  deploymentTarget: "16.4",
  entitlements: {
    // The group the app shares the instance's address and the session token in.
    "keychain-access-groups": ["$(AppIdentifierPrefix)com.ruchoir.app.shared"],
  },
});
