const { withEntitlementsPlist } = require('expo/config-plugins');

/**
 * Removes the `aps-environment` entitlement.
 *
 * `expo-widgets` writes it unconditionally, even with `enablePushNotifications`
 * off — and off it is: the Live Activity is updated by the app, never by a
 * push, so its Swift side requests no push token. An entitlement for a
 * capability the app does not use is the App Review question invariant 15
 * exists to avoid, and `expo-notifications`' own config plugin is left out of
 * `app.json` for the same reason (its alerts are local). If Live Activities
 * ever do get server push, delete this plugin and set `enablePushNotifications`.
 *
 * It must be listed *before* `expo-widgets` in `app.json`: mods run in reverse
 * plugin order, and listed after it this runs first and deletes nothing.
 */
module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (mod) => {
    delete mod.modResults['aps-environment'];
    return mod;
  });
};
