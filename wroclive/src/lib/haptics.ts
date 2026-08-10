import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * The app's whole vocabulary of touch feedback.
 *
 * Deliberately three verbs and no more. Haptics stop meaning anything the
 * moment everything buzzes, so they are reserved for the three moments where a
 * finger did something the eye has to catch up with: picking a thing off the
 * map, the sheet settling somewhere new, and a request failing.
 *
 * Every call is fire-and-forget. The engine is unavailable on the web, can be
 * switched off system-wide, and is missing on plenty of Android hardware —
 * none of which is a reason to interrupt anything, so a rejection is dropped.
 */

const supported = Platform.OS === 'ios' || Platform.OS === 'android';

const fire = (run: () => Promise<void>) => {
  if (!supported) return;
  run().catch(() => {
    // No engine, or the OS declined. Nothing about this is worth surfacing.
  });
};

/** Something was picked: a vehicle, a stop, an option in a list. */
export const tapped = () => fire(Haptics.selectionAsync);

/** A surface moved somewhere new under the finger — the sheet reaching a detent. */
export const settled = () =>
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));

/** Something the rider asked for did not work. */
export const failed = () =>
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
