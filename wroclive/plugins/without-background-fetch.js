const { withInfoPlist } = require('expo/config-plugins');

/**
 * Removes the `fetch` background mode.
 *
 * `expo-task-manager`'s config plugin is applied automatically and always adds
 * `UIBackgroundModes: fetch`. The widget refresh is a BGProcessing task
 * (`expo-background-task` adds `processing`, which is what it uses); the app
 * never uses background fetch, and a background mode it does not use is the
 * App Review question invariant 15 exists to avoid.
 */
module.exports = function withoutBackgroundFetch(config) {
  return withInfoPlist(config, (mod) => {
    const modes = mod.modResults.UIBackgroundModes;
    if (Array.isArray(modes)) {
      mod.modResults.UIBackgroundModes = modes.filter((mode) => mode !== 'fetch');
    }
    return mod;
  });
};
