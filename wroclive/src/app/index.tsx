import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { MapControls } from '@/components/map-controls';
import { MapLayers } from '@/components/map-layers';
import { MapSheet, MEDIUM_FRACTION, type Detent } from '@/components/map-sheet';
import { MapSheetHeader, MapSheetHome, type LiveStatus } from '@/components/map-sheet-home';
import { MapView, platformMapAvailable } from '@/components/map-view';
import type { MapRoute, MapSurfaceHandle, MapViewport } from '@/components/map-surface.types';
import { StopDetails, StopSummary } from '@/components/stop-details';
import { VehicleDetails, VehicleSummary } from '@/components/vehicle-details';
import { Space } from '@/constants/design';
import { useAreaStops } from '@/hooks/use-area-stops';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getAlerts, getDeparturesForStops, getIncidents, getLocations, getShape, getStopsNear, getVehicle, type FleetVehicle, type LineType, type Stop } from '@/lib/api';
import { REFRESH_MS } from '@/lib/config';
import { plural } from '@/lib/format';
import { colorFor } from '@/lib/lines';
import { mapIntentStore, useMapIntent } from '@/lib/map-intent';
import { usePreferences } from '@/lib/preferences';
import { failed, tapped } from '@/lib/haptics';
import { useSelectedLines } from '@/lib/selection';
import { groupStopAreas } from '@/lib/stops-api';

type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'stop'; stop: Stop }
  | null;

/** Clearance between the sheet's top edge and the map controls above it. */
const CONTROLS_GAP = Space.md;

/** How far around the rider the sheet's "near you" list reaches — a short walk. */
const NEARBY_RADIUS_METERS = 700;

export default function MapScreen() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const theme = useTheme();
  const screen = useWindowDimensions();
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
  /** Stops around the rider, for the sheet's list. Distinct from what the map draws. */
  const [myStops, setMyStops] = useState<Stop[]>([]);
  const [locating, setLocating] = useState(false);
  /** What the map is showing, reported by whichever surface is mounted. */
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* --- the sheet ------------------------------------------------------------ */

  const [detent, setDetent] = useState<Detent>('collapsed');
  const [layersOpen, setLayersOpen] = useState(false);

  /**
   * How much of the sheet is on screen, written by the sheet on every frame of
   * a drag. The map controls ride on it, which is what replaced the hardcoded
   * "188 when a vehicle is open, 262 when a stop is" offsets.
   */
  const sheetHeight = useSharedValue(0);

  const controlsStyle = useAnimatedStyle(() => {
    // Full visibility right through the medium detent — that is the detent a
    // rider spends most of their time at, and a locate button that has already
    // half-faded there reads as broken rather than as deliberate. Only past it,
    // where the sheet has covered the map and the controls have nothing left to
    // control, do they get out of the way instead of being pushed off the top.
    const fadeStart = screen.height * (MEDIUM_FRACTION + 0.02);
    const fadeEnd = fadeStart + 100;
    const rise = Math.min(sheetHeight.value + CONTROLS_GAP, fadeEnd);
    const fade = Math.max(0, Math.min(1, (fadeEnd - sheetHeight.value) / (fadeEnd - fadeStart)));
    return { transform: [{ translateY: -rise }], opacity: fade };
  });

  // The fleet payload has an authoritative timestamp. Tick only the copy in
  // the sheet header so "Live · 3 s temu" stays honest between ten-second polls.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

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

  // Only for the count on the sheet's "Utrudnienia" row — the incidents screen
  // does its own polling and owns the list. Old servers still expose /alerts.
  const incidentCount = usePoll(
    async (signal) => {
      try {
        const response = await getIncidents({ signal, retryWhileLoading: false });
        return response.incidents.filter((incident) => incident.status !== 'resolved').length;
      } catch {
        const response = await getAlerts({ signal, retryWhileLoading: false });
        return response.alerts.length;
      }
    },
    REFRESH_MS.alerts,
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
    tapped();
    setFocusedLine(null);
    setPinnedVehicle(null);
    setSelection({ kind: 'vehicle', id });
    setDetent('medium');
    setLayersOpen(false);
  }, []);
  const handleStop = useCallback((stop: Stop) => {
    tapped();
    setSelection({ kind: 'stop', stop });
    setDetent('medium');
    setLayersOpen(false);
  }, []);
  const handleBackground = useCallback(() => {
    setSelection(null);
    setFocusedLine(null);
    setPinnedVehicle(null);
    setDetent('collapsed');
    setLayersOpen(false);
  }, []);
  /**
   * Putting the open selection away.
   *
   * The sheet never leaves the screen — dragging it below its collapsed detent
   * means "I am done with this", so the home content comes back rather than the
   * map being left bare with chrome floating on it.
   */
  const closeSelection = useCallback(() => {
    setSelection(null);
    setFocusedLine(null);
    setPinnedVehicle(null);
  }, []);

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
      setDetent('medium');
    } else if (consumed?.kind === 'open-line') {
      setSelection(null);
      setPinnedVehicle(null);
      setFocusedLine({ line: consumed.line, type: consumed.type });
      setDetent('collapsed');
    } else if (consumed?.kind === 'open-vehicle') {
      mapRef.current?.centerOn(consumed.vehicle.lat, consumed.vehicle.lon, 16);
      setFocusedLine(null);
      setPinnedVehicle(consumed.vehicle);
      setSelection({ kind: 'vehicle', id: consumed.vehicle.id });
      setDetent('medium');
    }
  }, [intent, handleStop, handleVehicle]);

  /* --- where the rider is --------------------------------------------------- */

  /**
   * Why the locate button did nothing, when it did nothing.
   *
   * A button that silently does nothing is the worst version of this: the
   * rider presses it again, and again. Denial and failure are different
   * problems with different answers — one is fixed in Settings, the other by
   * trying again — so they are told apart and said out loud.
   */
  const [locateProblem, setLocateProblem] = useState<'denied' | 'failed' | null>(null);

  const locate = useCallback(async () => {
    setLocating(true);
    setLocateProblem(null);
    try {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        // Only "denied for good" sends someone to Settings; a dismissed prompt
        // can simply be asked again by pressing the button.
        setLocateProblem(canAskAgain ? null : 'denied');
        if (!canAskAgain) failed();
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = { lat: position.coords.latitude, lon: position.coords.longitude };

      setUserPosition(coords);
      mapRef.current?.centerOn(coords.lat, coords.lon, 16);

      // For the sheet's list only. What the map draws follows the viewport and
      // does not wait for this.
      setMyStops(await getStopsNear(coords.lat, coords.lon, NEARBY_RADIUS_METERS));
    } catch {
      // A fix can fail indoors, or the stops request can. Either way the map
      // still works — say so and let the rider try again.
      setLocateProblem('failed');
      failed();
    } finally {
      setLocating(false);
    }
  }, []);

  /* --- the stops layer -------------------------------------------------------- */

  /**
   * Stops follow the map, not the locate button.
   *
   * They used to appear only after the rider had shared their position, so
   * panning to a district you were not standing in showed a map with no stops
   * on it at all. Zooming in anywhere now loads what is there.
   */
  const areaStops = useAreaStops(viewport, showNearbyStops);

  const selectedStop = selection?.kind === 'stop' ? selection.stop : null;
  // The selected stop is always a map marker, even where the layer is off or
  // the stop is outside the loaded area. This also preserves the real
  // coordinates received from search instead of replacing them with the map
  // tap's id and name.
  const mapStops = useMemo(() => {
    if (!selectedStop || !Number.isFinite(selectedStop.lat) || !Number.isFinite(selectedStop.lon)) {
      return areaStops;
    }
    return [selectedStop, ...areaStops.filter((stop) => stop.id !== selectedStop.id)];
  }, [selectedStop, areaStops]);

  /**
   * The sheet's list: the places around the rider, not the raw platforms.
   *
   * `/stops/near` answers with one record per platform, so a street's stop came
   * back two or three times — the list read "Spółdzielcza 10 m / Spółdzielcza
   * 10 m / Spółdzielcza 40 m" and buried the next real stop below the fold.
   */
  const nearbyAreas = useMemo(() => groupStopAreas(myStops), [myStops]);

  /* --- status --------------------------------------------------------------- */

  const status: LiveStatus = (() => {
    if (fleet.error) return { text: 'Brak połączenia', freshness: 'Spróbujemy ponownie', tone: 'error' };
    if (!fleet.data) return { text: 'Łączenie z siecią', freshness: 'Pobieranie pojazdów', tone: 'loading' };
    if (!fleet.data.count) return { text: 'Brak pojazdów', freshness: 'Live', tone: 'loading' };
    return {
      text: `${fleet.data.count} ${plural(fleet.data.count, ['pojazd', 'pojazdy', 'pojazdów'])}`,
      freshness: freshnessLabel(fleet.data.lastUpdated, fleet.data.stale, now),
      tone: fleet.data.stale ? 'stale' : 'live',
    };
  })();

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
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
        selectedStopId={stopId}
        onSelectVehicle={handleVehicle}
        onSelectStop={handleStop}
        onBackground={handleBackground}
        onViewportChange={setViewport}
      />

      {/* Dismisses the layer picker without also clearing the selection, which
          a press on the map itself would. Below the controls in the tree so it
          never swallows a press meant for them. */}
      {layersOpen && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zamknij warstwy mapy"
          style={StyleSheet.absoluteFill}
          onPress={() => setLayersOpen(false)}
        />
      )}

      {/* Anchored to the bottom and lifted by the sheet, so one animated value
          keeps the controls just clear of it at every detent and mid-drag. */}
      <Animated.View
        pointerEvents="box-none"
        style={[styles.controls, { right: Space.lg }, controlsStyle]}>
        {layersOpen && (
          <View style={styles.layers}>
            <MapLayers onClose={() => setLayersOpen(false)} />
          </View>
        )}
        <MapControls
          controls={[
            ...(platformMapAvailable
              ? [
                  {
                    icon: 'layers-outline' as const,
                    label: 'Warstwy mapy',
                    onPress: () => setLayersOpen((open) => !open),
                  },
                ]
              : []),
            {
              icon: locating ? 'ellipsis-horizontal' : 'locate',
              label: 'Pokaż moją lokalizację',
              onPress: locate,
              disabled: locating,
            },
          ]}
        />
      </Animated.View>

      <MapSheet
        detent={detent}
        onDetentChange={setDetent}
        onDismiss={closeSelection}
        visibleHeight={sheetHeight}
        header={
          vehicleId ? (
            <VehicleSummary detail={detail.data} onClose={closeSelection} />
          ) : stopId && selectedStop ? (
            <StopSummary
              stop={selectedStop}
              userPosition={userPosition}
              onClose={closeSelection}
            />
          ) : (
            <MapSheetHeader
              status={status}
              onSearch={() => router.push('/search')}
              onSettings={() => router.push('/settings')}
            />
          )
        }>
        {/* Keyed off what is actually selected, so a dismissed sheet is not
            left rendering a departure board for a stop nobody picked. */}
        {vehicleId ? (
          <VehicleDetails
            detail={detail.data}
            loading={detail.loading}
            error={detail.error}
            onOpenRoute={() => {
              const vehicle = detail.data?.vehicle;
              if (vehicle) mapRef.current?.centerOn(vehicle.lat, vehicle.lon, 14);
            }}
          />
        ) : stopId ? (
          <StopDetails data={departures.data} loading={departures.loading} error={departures.error} />
        ) : (
          <MapSheetHome
            selectedLineCount={selectedLines.length}
            alertCount={incidentCount.data}
            nearbyAreas={nearbyAreas}
            located={userPosition !== null}
            locating={locating}
            locateProblem={locateProblem}
            offline={Boolean(fleet.error)}
            onRetry={fleet.refresh}
            onLines={() => router.push('/lines')}
            onAlerts={() => router.push('/alerts')}
            onLocate={locate}
            onStop={(stop) => {
              mapRef.current?.centerOn(stop.lat, stop.lon, 17);
              handleStop(stop);
            }}
          />
        )}
      </MapSheet>
    </View>
  );
}

// A stable empty array: a new `[]` every render would re-run the effects that
// push data into the map.
const EMPTY_VEHICLES: never[] = [];

function freshnessLabel(lastUpdated: string | null, stale: boolean, now: number) {
  if (!lastUpdated) return stale ? 'Dane nieaktualne' : 'Live';
  const parsed = Date.parse(lastUpdated);
  if (!Number.isFinite(parsed)) return stale ? 'Dane nieaktualne' : 'Live';
  const seconds = Math.max(0, Math.floor((now - parsed) / 1_000));
  const elapsed = seconds < 5 ? 'teraz' : seconds < 60 ? `${seconds} s temu` : `${Math.floor(seconds / 60)} min temu`;
  return stale ? `Ostatnio · ${elapsed}` : `Live · ${elapsed}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: { position: 'absolute', bottom: 0, alignItems: 'flex-end', gap: Space.sm },
  layers: { alignItems: 'flex-end' },
});
