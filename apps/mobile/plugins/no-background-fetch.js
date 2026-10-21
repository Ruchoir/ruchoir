/**
 * expo-task-manager adds the iPhone's `fetch` background mode whenever it is installed. The app never
 * fetches on a schedule: on an iPhone the task manager only hears the silent sync push, through the
 * `remote-notification` mode expo-notifications adds (`src/push/background.ts`), which stays. A
 * background mode the app does not use is a reason for App Review to refuse it (guideline 2.5.4), so
 * `fetch` goes.
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
