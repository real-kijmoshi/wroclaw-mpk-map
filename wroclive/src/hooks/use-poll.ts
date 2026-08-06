import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type PollState<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
};

/**
 * Re-fetch on an interval while the app is in the foreground.
 *
 * Polling a backgrounded app spends battery on data nobody is looking at, so
 * the timer stops on background and fires once immediately on return — coming
 * back to a ten-second-old fleet is the whole point of the screen.
 *
 * The previous value is kept when a fetch fails: a stale position with a
 * "connection lost" note beats an empty map.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  { enabled = true, key = '' }: { enabled?: boolean; key?: string } = {},
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // The fetcher is usually an inline closure; keeping it in a ref means a new
  // one does not restart the interval on every render. Written from an effect
  // rather than during render — this effect is declared first, so it has
  // already run by the time the polling effect below fires.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    // Android can briefly report `null` while the bridge learns the initial
    // state. Treat that boot window as active so the first screen still loads.
    let active = AppState.currentState === null || AppState.currentState === 'active';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (cancelled || (caught as Error)?.name === 'AbortError') return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (!active || cancelled) return;
      timer = setTimeout(async () => {
        await run();
        schedule();
      }, intervalMs);
    };

    const start = () => {
      if (!active || cancelled) return;
      run().then(() => {
        schedule();
      });
    };

    start();

    const subscription = AppState.addEventListener('change', (state) => {
      const nextActive = state === 'active';
      if (nextActive === active) return;
      active = nextActive;

      if (active) {
        start();
      } else {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        controller?.abort();
      }
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      subscription.remove();
    };
  }, [intervalMs, enabled, key, nonce]);

  // Derived, not stored: a disabled poll is not "loading", and setting that
  // from an effect would just be a second render saying the same thing.
  return { data, error, loading: enabled ? loading : false, refresh };
}
