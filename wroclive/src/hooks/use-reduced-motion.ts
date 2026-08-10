import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the rider has asked the system for less movement.
 *
 * Reduce Motion is not a preference about taste — for people with vestibular
 * disorders a sheet that springs past its target and settles back is the thing
 * that makes an app unusable. Everything in here that moves asks first: the
 * sheet swaps its spring for a short linear slide, and the map stops animating
 * the camera.
 *
 * It is read once and then subscribed to, because it can be turned on from
 * Control Centre while the app is open.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduced(enabled);
      })
      .catch(() => {
        // Not every platform answers. Full motion is the safe default: it is
        // what the app has always done.
      });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => setReduced(enabled),
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduced;
}
