import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { mapHtml, type MapMessage } from '@/lib/map-html';
import {
  enqueueLatest,
  type LiveMapHandle,
  type LiveMapProps,
  type MapCommand,
} from './live-map.types';

export type { LiveMapHandle, LiveMapProps, MapCommand };

/**
 * Hosts the Leaflet page and bridges it to React.
 *
 * Commands sent before the page reports `ready` are queued — the first poll of
 * /locations regularly wins the race against the WebView's own load.
 */
export const LiveMap = forwardRef<LiveMapHandle, LiveMapProps>(function LiveMap(
  { dark, onMessage },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const queue = useRef<MapCommand[]>([]);
  // A ref rather than state: a poll landing between "ready" and the next
  // render would otherwise queue behind a flush that already happened.
  const readyRef = useRef(false);

  // Remounting the WebView on a theme change would reload the map and lose the
  // viewport, so the HTML is generated once and the theme is sent as a command.
  const html = useMemo(() => mapHtml(dark), []); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback((command: MapCommand) => {
    const payload = JSON.stringify(command);
    webRef.current?.injectJavaScript(
      `window.__wroclive && window.__wroclive.handle(${JSON.stringify(payload)}); true;`,
    );
  }, []);

  /**
   * Flush whatever was sent before the page could receive it.
   *
   * Reached both from the page's own announcement and from `onLoadEnd`,
   * because injecting into a page that has not defined its handler yet is a
   * silent no-op — a map with tiles and no vehicles on it.
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
        enqueueLatest(queue.current, command);
        return;
      }
      post(command);
    },
    [post],
  );

  useImperativeHandle(ref, () => ({ send }), [send]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let message: MapMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as MapMessage;
      } catch {
        return;
      }

      if (message.type === 'ready') markReady();

      onMessage(message);
    },
    [onMessage, markReady],
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        source={{ html, baseUrl: 'https://wroclive.local' }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        onLoadEnd={markReady}
        // The map is the background; it must not flash white on a dark theme
        // while the page loads.
        style={[styles.web, { backgroundColor: dark ? '#000000' : '#f2f2f7' }]}
        containerStyle={styles.web}
        javaScriptEnabled
        domStorageEnabled
        // Leaflet handles its own gestures.
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setBuiltInZoomControls={false}
        allowsInlineMediaPlayback
        androidLayerType="hardware"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Explicit bounds are more reliable than flex inside an absolutely
  // positioned parent on Expo Go's iOS WebView.
  web: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'transparent' },
});
