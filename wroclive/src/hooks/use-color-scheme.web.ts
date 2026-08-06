import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/** Nothing to subscribe to: this only reports whether we are on the client. */
const subscribe = () => () => {};

/**
 * To support static rendering, this value needs to be re-calculated on the
 * client side for web.
 *
 * `useSyncExternalStore` is what React provides for exactly this — a value
 * that differs between the server snapshot and the client — so hydration is
 * handled without a state update fired from an effect.
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const colorScheme = useRNColorScheme();

  return hasHydrated ? colorScheme : 'light';
}
