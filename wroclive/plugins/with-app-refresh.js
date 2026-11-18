const { withInfoPlist } = require('expo/config-plugins');

/**
 * The widget refresh is an app refresh task, so the app declares `fetch` and
 * not `processing`.
 *
 * `expo-background-task` schedules a BGProcessing task out of the box, and iOS
 * runs those mostly overnight on the charger: the widget's boards went hours
 * without a refresh through the day. `patches/expo-background-task+*.patch`
 * makes it submit a `BGAppRefreshTaskRequest` instead (same identifier, same
 * JS task), which iOS runs through the day, as often as the rider tends to
 * open the app. An app refresh task needs the `fetch` background mode; a
 * processing task's `processing` mode is then unused, and a background mode the
 * app does not use is the App Review question invariant 15 exists to avoid.
 *
 * Registered after `expo-background-task` so it has the last word on the
 * list whichever order the mods run in, and the patch makes that plugin add
 * `fetch` too.
 */
module.exports = function withAppRefresh(config) {
  return withInfoPlist(config, (mod) => {
    const modes = Array.isArray(mod.modResults.UIBackgroundModes) ? mod.modResults.UIBackgroundModes : [];
    mod.modResults.UIBackgroundModes = [...new Set([...modes.filter((mode) => mode !== 'processing'), 'fetch'])];
    return mod;
  });
};
