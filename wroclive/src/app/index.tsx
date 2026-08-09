import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glass } from '@/components/glass';
import { MapView } from '@/components/map-view';
import type { MapRoute, MapSurfaceHandle } from '@/components/map-surface.types';
import { Sheet } from '@/components/sheet';
import { StopDetails } from '@/components/stop-details';
import { ThemedText } from '@/components/themed-text';
import { VehicleDetails } from '@/components/vehicle-details';
import { Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getDeparturesForStops, getLocations, getShape, getStopsNear, getVehicle, type FleetVehicle, type LineType, type Stop } from '@/lib/api';
import { REFRESH_MS } from '@/lib/config';
import { plural } from '@/lib/format';
import { colorFor } from '@/lib/lines';
import { mapIntentStore, useMapIntent } from '@/lib/map-intent';
import { usePreferences } from '@/lib/preferences';
import { selectionStore, useSelectedLines } from '@/lib/selection';

type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'stop'; stop: Stop }
  | null;

export default function MapScreen() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const mapRef = useRef<MapSurfaceHandle>(null);
  const selectedLines = useSelectedLines();
  const { showNearbyStops, followSelectedVehicle } = usePreferences();
  const [selection, setSelection] = useState<Selection>(null);
  // Stored with the vehicle it belongs to, so switching selection drops the
  // old route by derivation instead of by a second render that clears it.
  const [fetchedVehicle, setFetchedVehicle] = useState<{ vehicleId: string; route: MapRoute } | null>(null);
  const [fetchedLine, setFetchedLine] = useState<{ line: string; route: MapRoute } | null>(null);
  const [focusedLine, setFocusedLine] = useState<{ line: string; type: LineType } | null>(null);
  // A searched vehicle must remain visible even when the currently persisted
  // line filter deliberately excludes it.
  const [pinnedVehicle, setPinnedVehicle] = useState<FleetVehicle | null>(null);
  const [userPosition, setUserPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [nearbyStops, setNearbyStops] = useState<Stop[]>([]);
  const [locating, setLocating] = useState(false);

  /* --- the fleet ---------------------------------------------------------- */

  const linesKey = useMemo(() => [...selectedLines].sort().join(','), [selectedLines]);

  const fleet = usePoll(
    (signal) =>
      // Filtering server-side keeps a narrow selection a small payload rather
      // than the whole fleet fetched and then thrown away here.
      getLocations(selectedLines.length ? selectedLines : null, {
        signal,
        // A poll that lands in the boot window comes round again in ten
        // seconds; no need to hold the request open waiting.
        retryWhileLoading: false,
      }),
    REFRESH_MS.vehicles,
    { key: linesKey },
  );

  const filteredVehicles = fleet.data?.locations ?? EMPTY_VEHICLES;
  const vehicles = useMemo(() => {
    if (!pinnedVehicle || filteredVehicles.some((vehicle) => vehicle.id === pinnedVehicle.id)) {
      return filteredVehicles;
    }
    return [pinnedVehicle, ...filteredVehicles];
  }, [filteredVehicles, pinnedVehicle]);

  // Read inside effects that must not re-run on every poll.
  const fleetRef = useRef<FleetVehicle[]>(EMPTY_VEHICLES);
  useEffect(() => {
    fleetRef.current = vehicles;
  }, [vehicles]);

  /* --- what is selected ---------------------------------------------------- */

  const vehicleId = selection?.kind === 'vehicle' ? selection.id : null;
  const stopId = selection?.kind === 'stop' ? selection.stop.id : null;

  const detail = usePoll(
    (signal) => getVehicle(vehicleId as string, { signal }),
    REFRESH_MS.vehicles,
    { enabled: Boolean(vehicleId), key: vehicleId ?? '' },
  );

  const departures = usePoll(
    (signal) => {
      const selected = selection?.kind === 'stop'
        ? selection.stop
        : null;
      return selected ? getDeparturesForStops(selected, { signal }) : Promise.reject(new Error('No stop selected'));
    },
    REFRESH_MS.departures,
    { enabled: Boolean(stopId), key: stopId ?? '' },
  );

  /**
   * The route the selected vehicle is running.
   *
   * Fetched once per selection rather than once per poll: the shape does not
   * change while you watch it, and refetching would refit the viewport out
   * from under whoever is panning around. The heading goes with the request —
   * both directions share the street, so position alone picks the opposite
   * direction about half the time.
   */
  const vehicleRoute = fetchedVehicle?.vehicleId === vehicleId ? fetchedVehicle.route : null;
  const lineRoute = fetchedLine && fetchedLine.line === focusedLine?.line ? fetchedLine.route : null;
  const route = vehicleRoute ?? lineRoute;

  useEffect(() => {
    if (!vehicleId) return;

    const vehicle = fleetRef.current.find((entry) => entry.id === vehicleId);
    if (!vehicle) return;

    // Abort, not a flag: a vehicle tapped in quick succession would otherwise
    // leave the first request running its 503-retry backoff for up to a minute
    // after it stopped being relevant.
    const controller = new AbortController();
    getShape(
      vehicle.line,
      { lat: vehicle.lat, lon: vehicle.lon, heading: vehicle.heading },
      { signal: controller.signal },
    )
      .then((shape) => {
        if (controller.signal.aborted) return;
        setFetchedVehicle({
          vehicleId,
          route: { points: shape.points, color: colorFor(vehicle.type), stops: shape.stops },
        });
      })
      .catch(() => {
        // A line whose snapshot shipped without geometry still shows its
        // vehicle and its stop list; only the drawn route is missing. An
        // abort lands here too and is just as fine.
      });

    return () => controller.abort();
  }, [vehicleId]);

  /** An explicit line search draws the route even before a rider picks a vehicle. */
  useEffect(() => {
    if (!focusedLine) return;

    const controller = new AbortController();
    getShape(focusedLine.line, {}, { signal: controller.signal })
      .then((shape) => {
        if (controller.signal.aborted) return;
        setFetchedLine({
          line: focusedLine.line,
          route: { points: shape.points, color: colorFor(focusedLine.type), stops: shape.stops },
        });
      })
      .catch(() => {
        // The selected filter still applies if this feed snapshot has no shape.
      });

    return () => controller.abort();
  }, [focusedLine]);

  const handleVehicle = useCallback((id: string) => {
    setFocusedLine(null);
    setPinnedVehicle(null);
    setSelection({ kind: 'vehicle', id });
  }, []);
  const handleStop = useCallback((stop: Stop) => {
    setSelection({ kind: 'stop', stop });
  }, []);
  const handleBackground = useCallback(() => {
    setSelection(null);
    setFocusedLine(null);
    setPinnedVehicle(null);
  }, []);
  const closeSheet = useCallback(() => setSelection(null), []);

  // A stop opened from search posts an `open-stop` intent. It is consumed
  // here, once: the map recentres on the stop and the existing stop sheet
  // (selection + departures poll) opens beneath it, then the intent is cleared
  // so it is never acted on a second time.
  const intent = useMapIntent();
  useEffect(() => {
    const consumed = mapIntentStore.consume();
    if (consumed?.kind === 'open-stop') {
      const { stop } = consumed;
      mapRef.current?.centerOn(stop.lat, stop.lon, 16);
      // Reacting to an external intent is a genuine side effect, not derived
      // state, so the linter's synchronous-setState rule does not apply here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFocusedLine(null);
      setPinnedVehicle(null);
      setSelection({ kind: 'stop', stop });
    } else if (consumed?.kind === 'open-line') {
      setSelection(null);
      setPinnedVehicle(null);
      setFocusedLine({ line: consumed.line, type: consumed.type });
    } else if (consumed?.kind === 'open-vehicle') {
      mapRef.current?.centerOn(consumed.vehicle.lat, consumed.vehicle.lon, 16);
      setFocusedLine(null);
      setPinnedVehicle(consumed.vehicle);
      setSelection({ kind: 'vehicle', id: consumed.vehicle.id });
    }
  }, [intent, handleStop, handleVehicle]);

  /* --- where the rider is --------------------------------------------------- */

  const locate = useCallback(async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = { lat: position.coords.latitude, lon: position.coords.longitude };

      setUserPosition(coords);
      mapRef.current?.centerOn(coords.lat, coords.lon, 15);

      if (showNearbyStops) setNearbyStops(await getStopsNear(coords.lat, coords.lon));
    } catch {
      // Location is a convenience here; the map works without it.
    } finally {
      setLocating(false);
    }
  }, [showNearbyStops]);

  // Turning the setting off hides them straight away, without another render
  // spent clearing the list it was holding.
  const visibleStops = showNearbyStops ? nearbyStops : EMPTY_STOPS;
  const selectedStop = selection?.kind === 'stop' ? selection.stop : null;
  // The selected search result is always a map marker, even with the nearby
  // stops preference off. This also preserves the real coordinates received
  // from search instead of replacing them with the map tap's id and name.
  const mapStops = useMemo(() => {
    if (!selectedStop || !Number.isFinite(selectedStop.lat) || !Number.isFinite(selectedStop.lon)) {
      return visibleStops;
    }
    return [selectedStop, ...visibleStops.filter((stop) => stop.id !== selectedStop.id)];
  }, [selectedStop, visibleStops]);

  /* --- status --------------------------------------------------------------- */

  const status = (() => {
    if (fleet.error) return { text: 'Brak połączenia z serwerem', tone: 'error' as const };
    if (!fleet.data) return { text: 'Ładowanie…', tone: 'loading' as const };
    if (!fleet.data.count) return { text: 'Brak pojazdów w tej chwili', tone: 'loading' as const };
    return {
      text: `${fleet.data.count} ${plural(fleet.data.count, ['pojazd', 'pojazdy', 'pojazdów'])}`,
      tone: fleet.data.stale ? ('stale' as const) : ('live' as const),
    };
  })();

  const dotColor =
    status.tone === 'live'
      ? theme.success
      : status.tone === 'error'
        ? theme.danger
        : theme.textSecondary;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        dark={dark}
        vehicles={vehicles}
        route={route}
        selectedVehicleId={vehicleId}
        follow={followSelectedVehicle}
        fitRoute={Boolean(focusedLine)}
        userPosition={userPosition}
        nearbyStops={mapStops}
        onSelectVehicle={handleVehicle}
        onSelectStop={handleStop}
        onBackground={handleBackground}
      />

      {/* Floating chrome. `box-none` so taps fall through to the map itself. */}
      <View
        pointerEvents="box-none"
        style={[styles.overlay, { paddingTop: insets.top + Spacing.two }]}>
        <View style={styles.topRow} pointerEvents="box-none">
          <Glass variant="regular" style={styles.statusPill}>
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <View style={styles.statusText}>
              <ThemedText type="smallBold" numberOfLines={1}>
                {status.text}
              </ThemedText>
            </View>
          </Glass>

          {selectedLines.length > 0 && (
            <Pressable
              onPress={() => selectionStore.clear()}
              accessibilityRole="button"
              accessibilityLabel="Wyczyść filtr linii">
              <Glass variant="regular" interactive style={styles.filterChip}>
                <Ionicons name="funnel" size={13} color={theme.text} />
                <ThemedText type="smallBold">{selectedLines.length}</ThemedText>
                <Ionicons name="close" size={15} color={theme.textSecondary} />
              </Glass>
            </Pressable>
          )}

          <Pressable
            onPress={() => router.push('/search')}
            accessibilityRole="button"
            accessibilityLabel="Szukaj przystanku"
            style={({ pressed }) => [styles.searchButton, pressed && styles.pressed]}>
            <Glass variant="regular" interactive style={styles.searchButtonInner}>
              <Ionicons name="search" size={20} color={theme.text} />
            </Glass>
          </Pressable>
        </View>
      </View>

      <View
        pointerEvents="box-none"
        style={[styles.sideControls, { bottom: insets.bottom + Spacing.four }]}>
        <RoundButton
          icon="git-branch"
          label="Linie"
          onPress={() => router.push('/lines')}
          badge={selectedLines.length || undefined}
        />
        <RoundButton
          icon="warning-outline"
          label="Utrudnienia"
          onPress={() => router.push('/alerts')}
        />
        <RoundButton
          icon="settings-outline"
          label="Ustawienia"
          onPress={() => router.push('/settings')}
        />
        <RoundButton
          icon={locating ? 'ellipsis-horizontal' : 'locate'}
          label="Pokaż moją lokalizację"
          onPress={locate}
          disabled={locating}
        />
      </View>

      <Sheet
        visible={selection !== null}
        onClose={closeSheet}
        peekHeight={selection?.kind === 'vehicle' ? 340 : 300}>
        {/* Keyed off what is actually selected, so a dismissed sheet is not
            left rendering a departure board for a stop nobody picked. */}
        {vehicleId ? (
          <VehicleDetails detail={detail.data} loading={detail.loading} error={detail.error} />
        ) : stopId ? (
          <StopDetails data={departures.data} loading={departures.loading} error={departures.error} />
        ) : null}
      </Sheet>
    </View>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
  disabled,
  badge,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  badge?: number;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.roundButtonPressable,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <View style={styles.roundButtonWrap}>
        <Glass variant="regular" interactive style={styles.roundButton}>
          <Ionicons name={icon} size={20} color={theme.text} />
        </Glass>
        {badge !== undefined && (
          // Outside Glass on purpose: Glass clips to its rounded shape with
          // `overflow: hidden`, which cut off this badge where it pokes past
          // the button's edge.
          <View style={[styles.badge, { backgroundColor: theme.text }]}>
            <ThemedText
              type="small"
              style={[styles.badgeText, { color: theme.background }]}
              allowFontScaling={false}>
              {badge}
            </ThemedText>
          </View>
        )}
      </View>
    </Pressable>
  );
}

// Stable empty arrays: a new `[]` every render would re-run the effects that
// push data into the map.
const EMPTY_VEHICLES: never[] = [];
const EMPTY_STOPS: never[] = [];

/** Floating chrome needs a shadow to separate it from the map underneath. */
const shadow = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  android: { elevation: 6 },
  default: { boxShadow: '0 4px 14px rgba(0,0,0,0.18)' },
}) as object;

const styles = StyleSheet.create({
  container: { flex: 1 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.three,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statusPill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 22,
    ...shadow,
  },
  statusText: { flexShrink: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 22,
    ...shadow,
  },
  searchButton: {
    marginLeft: 'auto',
  },
  searchButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
  sideControls: {
    position: 'absolute',
    right: Spacing.three,
    gap: Spacing.two,
  },
  roundButtonWrap: {
    width: 46,
    height: 46,
  },
  roundButtonPressable: { borderRadius: 23 },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
});
