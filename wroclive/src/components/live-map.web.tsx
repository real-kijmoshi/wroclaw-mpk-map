import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { mapHtml, type MapMessage } from '@/lib/map-html';
import type { LiveMapHandle, LiveMapProps, MapCommand } from './live-map.types';

export type { LiveMapHandle, LiveMapProps, MapCommand };

/**
 * The web build of the same map.
 *
 * `react-native-webview` has no web target, but nothing here needs one: the map
 * is plain HTML, so the browser renders the real page in an `<iframe>`. This is
 * a real preview of the map, not a stub of it — only the transport changes,
 * from the native bridge to `postMessage`.
 */
export const LiveMap = forwardRef<LiveMapHandle, LiveMapProps>(function LiveMap(
  { dark, onMessage },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const queue = useRef<MapCommand[]>([]);
  // Readiness lives in a ref, not state: the first poll can land between the
  // page reporting ready and a re-render, and a stale `false` in a closure
  // would queue that command behind a flush that has already happened.
  const readyRef = useRef(false);

  const html = useMemo(() => mapHtml(dark), []); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback((command: MapCommand) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(command), '*');
  }, []);

  /**
   * Flush whatever was sent before the page could receive it.
   *
   * Reached three ways, because two of them are races. A `srcDoc` iframe can
   * finish loading before React attaches `onLoad`, and the page's own
   * announcement can be posted before this component has a listener up — miss
   * both and the queue never drains, which looks exactly like a map that draws
   * its tiles and no vehicles at all. The poll below closes it: it watches for
   * the one thing that actually matters, the page's handler existing.
   */
  const markReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    const pending = queue.current;
    queue.current = [];
    for (const command of pending) post(command);
  }, [post]);

  const send = useCallback(
    (command: MapCommand) => {
      if (!readyRef.current) {
        queue.current.push(command);
        return;
      }
      post(command);
    },
    [post],
  );

  useImperativeHandle(ref, () => ({ send }), [send]);

  // The page's handler is the real precondition for posting anything, so watch
  // for it directly rather than trusting a load event that may already be gone.
  useEffect(() => {
    if (readyRef.current) return;

    const check = () => {
      const api = (frameRef.current?.contentWindow as { __wroclive?: unknown } | null)?.__wroclive;
      if (!api) return false;
      markReady();
      return true;
    };

    if (check()) return;
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [markReady]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      // Only the frame we rendered talks to us.
      if (event.source !== frameRef.current?.contentWindow) return;

      let message: MapMessage;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : (event.data as MapMessage);
      } catch {
        return;
      }
      if (!message?.type) return;

      if (message.type === 'ready') markReady();
      onMessage(message);
    };

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onMessage, markReady]);

  return (
    <View style={styles.container}>
      <iframe
        ref={frameRef}
        srcDoc={html}
        onLoad={markReady}
        title="Mapa"
        style={{ border: 'none', width: '100%', height: '100%', display: 'block' }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' },
});
