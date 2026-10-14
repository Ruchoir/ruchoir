/**
 * expo-task-manager adds the iPhone's `fetch` background mode whenever it is installed. The app uses
 * the task manager on Android only (phone notifications, `src/push/background.ts`); on an iPhone a
 * push is handled by the notification extension. A background mode the app does not use is a reason
 * for App Review to refuse it (guideline 2.5.4), so it goes.
 */
const { withInfoPlist } = require("expo/config-plugins");

module.exports = function withoutBackgroundFetch(config) {
  return withInfoPlist(config, (config) => {
    const modes = (config.modResults.UIBackgroundModes ?? []).filter((mode) => mode !== "fetch");
    if (modes.length > 0) config.modResults.UIBackgroundModes = modes;
    else delete config.modResults.UIBackgroundModes;
    return config;
  });
};
