import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Maps, {
  Marker,
  Polyline,
  UrlTile,
  type MapMarker,
  type MapMarkerProps,
  type MapType,
  type Region,
} from 'react-native-maps';

import type { MapSurfaceHandle, MapSurfaceProps, MapViewport } from './map-surface.types';
import { Elevation, HitTarget, Radius, Weight } from '@/constants/design';
import { useMapChrome } from '@/hooks/use-map-chrome';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import type { FleetVehicle, Stop } from '@/lib/api';
import { colorFor, isTram } from '@/lib/lines';
import { BACKWARD_TOLERANCE_METERS, projectProgress, splitRoute, type RouteProgress, type RouteSplit } from '@/lib/route-progress';
import { WROCLAW_CENTER } from '@/lib/map-html';
import { usePreferences } from '@/lib/preferences';
import {
  DOT_SIZE,
  DOT_TAIL_HALF_BASE,
  DOT_TAIL_LENGTH,
  DOT_TAIL_OUTLINE,
  TAIL_HALF_BASE,
  TAIL_LENGTH,
  TAIL_OUTLINE,
  dotMarkerGeometry,
  dotSizeForDensity,
  headingBucket,
  vehicleMarkerGeometry,
} from '@/lib/vehicle-marker';

/**
 * react-native-maps `Polyline` has no opacity prop, so the dimmed travelled
 * segment is expressed as the route colour with alpha baked in.
 */
function fadeColor(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The map, drawn by the platform.
 *
 * MapKit on iOS, Google's map on Android — the real thing, gestures and labels
 * and all, rather than a page in a WebView. `react-native-maps` is a native
 * module, but it is one of the modules Expo Go carries (`AIRMap` is in the Expo
 * Go binary), so this renders in Expo Go as well as in a build.
 *
 * The web build cannot have it — there is no web implementation — so
 * `map-view.web.tsx` hands the Leaflet page back there instead. Nothing above
 * this file knows which one it got.
 */

/** How long a marker keeps redrawing after its appearance changes. */
const MARKER_TRACK_MS = 350;

/** How long the camera takes to travel, when it is allowed to travel at all. */
const CAMERA_MS = 450;

/**
 * How long a vehicle takes to walk from its last fix to the new one.
 *
 * MPK's feed is a ten-second snapshot, so a marker that simply takes the new
 * coordinate teleports a hundred metres or more on every poll — the whole fleet
 * blinking forward in step, which reads as a glitch rather than as traffic.
 * Both platforms can interpolate between the two fixes themselves (a
 * `CADisplayLink` on iOS, an `ObjectAnimator` on Android), so the travel costs
 * no React render and no bridge traffic per frame.
 *
 * It has to be a whole second. `RNMapsMarkerView.mm` passes the duration on as
 * `duration / 1000` in integer arithmetic, so anything under 1000ms arrives on
 * iOS as a zero-second animation — which is the jump this exists to remove.
 * The Leaflet page uses the same number for the same motion.
 */
const GLIDE_MS = 1000;

/**
 * Keep one extra half-viewport of markers around every edge. Panning stays
 * seamless, while a close city view no longer mounts hundreds of offscreen
 * native views.
 */
const MARKER_OVERSCAN_RATIO = 0.5;

/**
 * How the fleet is drawn, by how much of the city is on screen.
 *
 * Seven hundred markers at city zoom was not a map of a tram network, it was a
 * rash: every vehicle drawn as its own dot, at a scale where two dots two
 * hundred metres apart land on the same pixel. Zooming out should say *where
 * the network is busy*; zooming in should say *which vehicle is which*. These
 * are the two deltas where that changes.
 */
const FAR_DELTA = 0.12;
const NEAR_DELTA = 0.03;

type Tier = 'far' | 'mid' | 'near';

/**
 * The grid a marker has to have to itself, in points.
 *
 * At `far` a cell holds one dot and the rest are dropped — but the survivor is
 * sized by how many it stands for, so the pile-up turns into density instead
 * of vanishing. At `near` nothing is dropped: the loser of a cell falls back to
 * a dot, which is what stops two labels from landing on top of each other the
 * way "1" and "121" did.
 */
const THIN_CELL = 26;
const LABEL_CELL = 46;

/**
 * Stop names need more room than a line badge — they are words, not two
 * digits — so they claim a wider cell before one gives way to a bare dot.
 */
const STOP_LABEL_CELL = 78;

/** A Leaflet zoom level as the region span `react-native-maps` speaks in. */
const deltaForZoom = (zoom: number) => 360 / 2 ** zoom;

/** …and back, so the surface can report its scale in the shared vocabulary. */
const zoomForDelta = (delta: number) =>
  delta > 0 ? Math.log2(360 / delta) : WROCLAW_CENTER.zoom;

/**
 * The region, as the viewport contract states it.
 *
 * The radius is half the diagonal, so the circle covers the corners of the
 * screen rather than just its middle — a stops request built from the shorter
 * axis leaves gaps at the edges the rider can plainly see.
 */
function viewportOf(region: Region): MapViewport {
  const latitudeMeters = region.latitudeDelta * METERS_PER_DEGREE;
  const longitudeMeters =
    region.longitudeDelta * METERS_PER_DEGREE * Math.cos((region.latitude * Math.PI) / 180);
  return {
    lat: region.latitude,
    lon: region.longitude,
    radiusMeters: Math.round(Math.hypot(latitudeMeters, longitudeMeters) / 2),
    zoom: zoomForDelta(region.latitudeDelta),
  };
}

const METERS_PER_DEGREE = 111_320;

const INITIAL_REGION: Region = {
  latitude: WROCLAW_CENTER.lat,
  longitude: WROCLAW_CENTER.lon,
  latitudeDelta: deltaForZoom(WROCLAW_CENTER.zoom),
  longitudeDelta: deltaForZoom(WROCLAW_CENTER.zoom),
};

/**
 * A marker with a custom child view keeps the first snapshot it took once
 * `tracksViewChanges` is false — which is what makes a few hundred of them
 * affordable, and also means a style change never reaches the screen. This
 * turns tracking back on for a beat whenever the look changes, and off again
 * once the new appearance has been captured.
 */
function useMarkerRedraw(look: string) {
  const [capturedLook, setCapturedLook] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setCapturedLook(look), MARKER_TRACK_MS);
    return () => clearTimeout(timer);
  }, [look]);

  return capturedLook !== look;
}

const coordinate = (lat: number, lon: number) => ({
  latitude: Number(lat),
  longitude: Number(lon),
});

/**
 * A dot keeps a dot-sized box: a bare marker inside the box a labelled one
 * needs would swallow the taps meant for its neighbours at a busy stop.
 */
const DOT_MIN_BOX = 20;

/** A heavier ring once the dot is big enough to carry one. */
const dotBorderFor = (size: number) => (size >= 10 ? 2 : 1.5);

type VehicleMarkerProps = {
  vehicle: FleetVehicle;
  dimmed: boolean;
  selected: boolean;
  /** Full badge with the line number, or the bare dot. */
  labelled: boolean;
  /** The dot's diameter when it is not labelled: its tier, or its cell's count. */
  dotSize: number;
  /** Whether that dot carries the heading tail — false at city zoom. */
  dotTail: boolean;
  /** Travel to the new fix, rather than appear at it. */
  glide: boolean;
  onPress: (id: string) => void;
};

const VehicleMarker = memo(
  function VehicleMarker({
    vehicle,
    dimmed,
    selected,
    labelled,
    dotSize,
    dotTail,
    glide,
    onPress,
  }: VehicleMarkerProps) {
    // Heading is bucketed to 15°: redrawing for every degree of GPS jitter is
    // redrawing constantly, and nobody can see 5° on a 30pt badge. Same bucket
    // the Leaflet page uses — and the same one the marker is *drawn* at, since
    // a rotation the key does not notice is never captured to the screen.
    const bucket = headingBucket(vehicle.heading);
    const tracking = useMarkerRedraw(
      `${vehicle.line}|${vehicle.type}|${dimmed}|${selected}|${labelled}|${dotSize}|${dotTail}|${bucket}`,
    );

    const towards = vehicle.trip?.towards ?? vehicle.trip?.headsign ?? null;
    const tint = colorFor(vehicle.type);
    const tram = isTram(vehicle.type);

    // The marker and its tail are one shape, so where the tail meets the
    // outline depends on that outline's width, its corner radius and the
    // heading all at once. `vehicle-marker.ts` solves it, and sizes the box to
    // fit — for the badge and for the dot alike.
    const badge = useMemo(
      () => vehicleMarkerGeometry(vehicle.line, tram, selected, vehicle.heading, HitTarget),
      // Bucketed, so the box the map measures changes only when the drawn
      // angle does — the geometry and the redraw key must agree exactly.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [vehicle.line, tram, selected, bucket],
    );
    const dot = useMemo(
      () => dotMarkerGeometry(tram, dotSize, dotTail ? vehicle.heading : null, DOT_MIN_BOX),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [tram, dotSize, dotTail, bucket],
    );
    const geometry = labelled ? badge : dot;

    const markerRef = useRef<MapMarker>(null);

    /*
     * Where the marker is standing right now — which is one fix behind the one
     * that just arrived, because the new fix goes to the platform's own marker
     * animator instead of into this prop.
     *
     * The prop cannot carry the live fix: setting it moves the marker outright,
     * which is the teleport being removed, and it would also cut short a glide
     * already under way. It cannot be dropped either — a marker whose position
     * only ever came from a native command would sit still for good on any
     * platform where that command turned out to be a no-op. Carrying the fix the
     * marker has already arrived at is both: every write lands where the marker
     * already is, and the fleet still advances a poll at a time if the animator
     * ever stops working.
     *
     * `react-hooks/refs` forbids reading a ref during render; this one holds the
     * single value that must *not* be recomputed from props on every render —
     * the last position the native side was told about.
     */
    /* eslint-disable react-hooks/refs */
    const arrived = useRef(coordinate(vehicle.lat, vehicle.lon));
    const standingAt = arrived.current;
    /* eslint-enable react-hooks/refs */

    useEffect(() => {
      const next = coordinate(vehicle.lat, vehicle.lon);
      if (next.latitude === arrived.current.latitude && next.longitude === arrived.current.longitude) {
        return;
      }
      arrived.current = next;
      // Reduce Motion still goes through the animator, so there is one path to
      // the marker's position; a zero duration lands it on the fix next frame.
      markerRef.current?.animateMarkerToCoordinate(next, glide ? GLIDE_MS : 0);
    }, [glide, vehicle.lat, vehicle.lon]);

    return (
      <Marker
        ref={markerRef}
        coordinate={standingAt}
        // Google Maps/Android uses a normalized anchor. Apple Maps ignores that
        // prop and uses centerOffset instead, so explicitly select the centring
        // mechanism for each renderer.
        anchor={Platform.OS === 'ios' ? undefined : ANCHOR_CENTRE}
        centerOffset={Platform.OS === 'ios' ? APPLE_CENTRE_OFFSET : undefined}
        tracksViewChanges={tracking}
        // The selected vehicle is never allowed to end up under another marker.
        zIndex={selected ? 1000 : labelled ? 10 : 1}
        // Android bubbles a marker tap through to the map underneath, which
        // would clear the very selection the tap just made.
        onPress={(event) => {
          event.stopPropagation();
          onPress(vehicle.id);
        }}
        accessibilityLabel={
          towards ? `Linia ${vehicle.line} do ${towards}` : `Linia ${vehicle.line}`
        }>
        <View
          style={[
            // Every box is only as big as the shape drawn in it — the labelled
            // one floored at one finger's width, the dot deliberately not.
            {
              width: geometry.boxWidth,
              height: geometry.boxHeight,
              alignItems: 'center',
              justifyContent: 'center',
            },
            dimmed && styles.vehicleDimmed,
          ]}>
          {/*
           * The tail. It is drawn first, so the badge or dot covers the few
           * points of it that sink inside the outline, and the two read as one
           * shape. The layer fills the box and rotates about that shape's
           * centre — the shape itself never turns, so the line number is always
           * the right way up.
           */}
          {geometry.tailTop !== null && (
            <View
              style={[styles.tailLayer, { transform: [{ rotate: `${geometry.angle}deg` }] }]}>
              <View
                style={[
                  labelled ? styles.tailOutline : styles.dotTailOutline,
                  { top: geometry.outlineTop as number },
                ]}
              />
              <View
                style={[
                  labelled ? styles.tail : styles.dotTail,
                  { top: geometry.tailTop, borderBottomColor: tint },
                ]}
              />
            </View>
          )}

          {labelled ? (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: tint,
                  width: badge.badgeWidth,
                  height: badge.badgeHeight,
                  borderRadius: badge.badgeRadius,
                  borderWidth: selected ? 2.5 : 1.5,
                },
                selected && styles.badgeSelected,
              ]}>
              <Text
                numberOfLines={1}
                allowFontScaling={false}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={[styles.label, vehicle.line.length > 3 && styles.labelLong]}>
                {vehicle.line}
              </Text>
            </View>
          ) : (
            <View
              style={[
                styles.dot,
                {
                  backgroundColor: tint,
                  width: dot.dotSize,
                  height: dot.dotSize,
                  // Shape carries the mode as well as colour: a red dot and a
                  // blue dot are the same dot to anyone who cannot separate the
                  // two hues, and this map is read in sunlight.
                  borderRadius: dot.dotRadius,
                  borderWidth: dotBorderFor(dot.dotSize),
                },
              ]}
            />
          )}
        </View>
      </Marker>
    );
  },
  (previous, next) =>
    previous.vehicle.id === next.vehicle.id &&
    previous.vehicle.line === next.vehicle.line &&
    previous.vehicle.type === next.vehicle.type &&
    previous.vehicle.lat === next.vehicle.lat &&
    previous.vehicle.lon === next.vehicle.lon &&
    previous.vehicle.heading === next.vehicle.heading &&
    previous.vehicle.trip?.towards === next.vehicle.trip?.towards &&
    previous.vehicle.trip?.headsign === next.vehicle.trip?.headsign &&
    previous.dimmed === next.dimmed &&
    previous.selected === next.selected &&
    previous.labelled === next.labelled &&
    previous.dotSize === next.dotSize &&
    previous.dotTail === next.dotTail &&
    previous.glide === next.glide &&
    previous.onPress === next.onPress,
);

type StopMarkerProps = {
  stop: Stop;
  tint: string;
  /** Draw the name beside the dot. */
  labelled: boolean;
  selected: boolean;
  /** Light text with a dark halo, or the reverse — set by the base map. */
  onDark: boolean;
  onPress: (stop: Stop) => void;
};

const StopMarker = memo(function StopMarker({
  stop,
  tint,
  labelled,
  selected,
  onDark,
  onPress,
}: StopMarkerProps) {
  const tracking = useMarkerRedraw(`${tint}|${labelled}|${selected}|${onDark}`);

  return (
    <Marker
      coordinate={coordinate(stop.lat, stop.lon)}
      // The dot is what sits on the coordinate; the name hangs below it. Both
      // anchors put the *dot* on the stop, not the middle of the label box.
      anchor={labelled ? STOP_LABEL_ANCHOR : ANCHOR_CENTRE}
      centerOffset={
        Platform.OS === 'ios'
          ? labelled
            ? STOP_LABEL_OFFSET
            : APPLE_CENTRE_OFFSET
          : undefined
      }
      tracksViewChanges={tracking}
      zIndex={selected ? 900 : labelled ? 6 : 5}
      onPress={(event) => {
        event.stopPropagation();
        onPress(stop);
      }}
      accessibilityLabel={`Przystanek ${stop.name}`}>
      <View style={labelled ? styles.stopLabelled : styles.stopWrapper}>
        <View
          style={[
            styles.stopDot,
            { borderColor: tint },
            selected && styles.stopDotSelected,
          ]}
        />
        {labelled && (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={[
              styles.stopName,
              // A halo rather than a chip: dozens of filled pills turn a map
              // into a list, and this is how the base map draws its own labels.
              onDark ? styles.stopNameOnDark : styles.stopNameOnLight,
              selected && styles.stopNameSelected,
            ]}>
            {stop.name}
          </Text>
        )}
      </View>
    </Marker>
  );
});

export const NativeMap = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function NativeMap(
  {
    dark,
    vehicles,
    route,
    selectedVehicleId,
    follow = false,
    fitRoute = false,
    userPosition,
    nearbyStops,
    selectedStopId,
    onSelectVehicle,
    onSelectStop,
    onBackground,
    onViewportChange,
  },
  ref,
) {
  const mapRef = useRef<Maps>(null);
  const viewport = useWindowDimensions();
  const { mapProvider, appleMapType } = usePreferences();
  const { scheme } = useMapChrome();
  const reducedMotion = useReducedMotion();
  const [visibleRegion, setVisibleRegion] = useState(INITIAL_REGION);

  /**
   * How long the camera takes to get somewhere.
   *
   * Reduce Motion means the map cuts rather than flies: a camera sweeping
   * across the city is exactly the kind of large movement that setting exists
   * to remove. Kept in a ref so `centerOn` — which is built once — reads the
   * current answer instead of the one from mount.
   */
  const cameraMs = useRef(CAMERA_MS);
  useEffect(() => {
    cameraMs.current = reducedMotion ? 0 : CAMERA_MS;
  }, [reducedMotion]);

  useImperativeHandle(
    ref,
    () => ({
      centerOn(lat, lon, zoom) {
        const delta = deltaForZoom(zoom ?? 15);
        mapRef.current?.animateToRegion(
          { latitude: lat, longitude: lon, latitudeDelta: delta, longitudeDelta: delta },
          cameraMs.current,
        );
      },
    }),
    [],
  );

  const validVehicles = useMemo(
    () => vehicles.filter((vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon)),
    [vehicles],
  );

  const selected = useMemo(
    () => validVehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [validVehicles, selectedVehicleId],
  );

  /**
   * Last accepted route projection, kept so a GPS jitter that lands far behind
   * the previous fix cannot make the travelled line shrink backwards. Reset
   * whenever the selection changes.
   */
  const progressRef = useRef<{ vehicleId: string; progress: RouteProgress } | null>(null);
  useEffect(() => {
    if (!selectedVehicleId) progressRef.current = null;
  }, [selectedVehicleId]);

  /*
   * `react-hooks/refs` forbids reading/writing a ref during render, but the
   * route split needs the *previous* accepted projection as a continuity hint so
   * a jittery fix can't send the travelled line hopping backwards. A mutable
   * ref is the canonical place to keep that one value, and the projection is
   * idempotent, so reading-writing it here is safe under concurrent rendering.
   */
  /* eslint-disable react-hooks/refs */
  const split = useMemo<RouteSplit | null>(() => {
    if (!route || route.points.length < 2 || !selectedVehicleId || !selected) return null;
    const prev =
      progressRef.current?.vehicleId === selectedVehicleId ? progressRef.current.progress : null;
    const projected = projectProgress(
      route.points,
      selected.lat,
      selected.lon,
      prev ? { segmentIndex: prev.segmentIndex, alongMeters: prev.alongMeters } : undefined,
    );
    if (!projected) return null;
    if (prev && projected.alongMeters < prev.alongMeters - BACKWARD_TOLERANCE_METERS) {
      // Implausible backward jump: hold the last good split instead of moving
      // it backwards.
      return splitRoute(route.points, prev);
    }
    progressRef.current = { vehicleId: selectedVehicleId, progress: projected };
    return splitRoute(route.points, projected);
  }, [route, selected, selectedVehicleId]);
  /* eslint-enable react-hooks/refs */

  const travelledCoordinates = useMemo(
    () => split?.travelled.map(([latitude, longitude]) => ({ latitude, longitude })) ?? null,
    [split],
  );
  const remainingCoordinates = useMemo(
    () => split?.remaining.map(([latitude, longitude]) => ({ latitude, longitude })) ?? null,
    [split],
  );

  const tier: Tier =
    visibleRegion.latitudeDelta > FAR_DELTA
      ? 'far'
      : visibleRegion.latitudeDelta > NEAR_DELTA
        ? 'mid'
        : 'near';

  /**
   * Which vehicles are drawn, and as what.
   *
   * Culling to the viewport comes first, then the tier decides. `far` thins to
   * one marker per cell; `near` keeps everything but only lets one label per
   * (larger) cell through, so a busy junction shows the vehicles without the
   * numbers landing on top of each other.
   *
   * The ordering is sorted by id rather than left in fleet order so the marker
   * that wins a cell is the same one from poll to poll. Ordering by whatever
   * the payload happened to list first made the survivor change every ten
   * seconds, and the map twinkled.
   */
  const placements = useMemo(() => {
    const latitudeRadius = visibleRegion.latitudeDelta * (0.5 + MARKER_OVERSCAN_RATIO);
    const longitudeRadius = visibleRegion.longitudeDelta * (0.5 + MARKER_OVERSCAN_RATIO);

    const inView = validVehicles.filter(
      (vehicle) =>
        Math.abs(vehicle.lat - visibleRegion.latitude) <= latitudeRadius &&
        Math.abs(vehicle.lon - visibleRegion.longitude) <= longitudeRadius,
    );

    // Following or fitting a selected vehicle must never lose its marker just
    // because the region completion event has not arrived yet.
    if (selected && !inView.some((vehicle) => vehicle.id === selected.id)) {
      inView.push(selected);
    }

    // The selected vehicle is considered first, so it always wins its cell.
    const ordered = inView
      .slice()
      .sort((a, b) =>
        a.id === selectedVehicleId ? -1 : b.id === selectedVehicleId ? 1 : a.id < b.id ? -1 : 1,
      );

    if (tier === 'mid') {
      // Every vehicle is its own dot here, and the dot carries the heading:
      // district zoom is where the flow of the network reads.
      return ordered.map((vehicle) => ({
        vehicle,
        labelled: vehicle.id === selectedVehicleId,
        dotSize: DOT_SIZE,
        dotTail: true,
      }));
    }

    const cell = tier === 'far' ? THIN_CELL : LABEL_CELL;
    const cellLat = (visibleRegion.latitudeDelta * cell) / Math.max(1, viewport.height);
    const cellLon = (visibleRegion.longitudeDelta * cell) / Math.max(1, viewport.width);
    const cellOf = (vehicle: FleetVehicle) =>
      `${Math.round(vehicle.lat / cellLat)}:${Math.round(vehicle.lon / cellLon)}`;

    // How crowded each cell is, which at `far` is the only thing the surviving
    // marker can say about the ones it stands in for.
    const counts = new Map<string, number>();
    for (const vehicle of ordered) {
      const key = cellOf(vehicle);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const taken = new Set<string>();
    const result: {
      vehicle: FleetVehicle;
      labelled: boolean;
      dotSize: number;
      dotTail: boolean;
    }[] = [];
    for (const vehicle of ordered) {
      const key = cellOf(vehicle);
      const free = !taken.has(key);
      if (free) taken.add(key);

      if (tier === 'far') {
        // Nothing is drawn twice in a cell — except the selected vehicle, which
        // is first in the ordering and therefore always the one that took it.
        // The survivor is sized by the count, and carries no heading: at this
        // scale it stands for its whole cell, and a direction would be a claim
        // about the vehicles it swallowed as much as about itself.
        if (free) {
          result.push({
            vehicle,
            labelled: false,
            dotSize: dotSizeForDensity(counts.get(key) ?? 1),
            dotTail: false,
          });
        }
        continue;
      }

      result.push({
        vehicle,
        labelled: free || vehicle.id === selectedVehicleId,
        dotSize: DOT_SIZE,
        dotTail: true,
      });
    }

    return result;
  }, [selected, selectedVehicleId, tier, validVehicles, viewport.height, viewport.width, visibleRegion]);

  useEffect(() => {
    if (!follow || !selected) return;
    // The camera travels for exactly as long as the marker does, so a followed
    // vehicle holds still under the crosshair and the city slides past it.
    // Chasing a 1s glide with a 450ms camera makes the vehicle bounce out of
    // the middle of the screen and back on every poll.
    mapRef.current?.animateCamera(
      { center: { latitude: selected.lat, longitude: selected.lon } },
      { duration: reducedMotion ? 0 : GLIDE_MS },
    );
  }, [follow, reducedMotion, selected]);

  const routeKey = route && fitRoute ? `${route.color}|${route.points.length}|${route.stops.length}` : null;
  useEffect(() => {
    if (!fitRoute || !route?.points.length) return;
    mapRef.current?.fitToCoordinates(
      route.points.map(([latitude, longitude]) => ({ latitude, longitude })),
      { edgePadding: { top: 120, right: 64, bottom: 380, left: 64 }, animated: !reducedMotion },
    );
    // An explicit line search fits; selecting a vehicle keeps that vehicle centred.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const routeCoordinates = useMemo(
    () => (route ? route.points.map(([latitude, longitude]) => ({ latitude, longitude })) : []),
    [route],
  );

  const handleStop = useCallback((stop: Stop) => onSelectStop(stop), [onSelectStop]);
  const handleRegionChange = useCallback(
    (region: Region) => {
      setVisibleRegion(region);
      onViewportChange?.(viewportOf(region));
    },
    [onViewportChange],
  );

  /**
   * Which stops get their name, and which stay a dot.
   *
   * Two rules, in order. A place is named once: `/stops/near` answers with one
   * record per platform, so a junction came back as "Galeria Dominikańska"
   * five times over, printed five times across the same block. Then the same
   * screen-cell trick the vehicles use, because two *different* names landing
   * on one patch of screen is still worse than one name and a dot.
   *
   * Every platform keeps its dot either way — they are different boarding
   * points, and tapping the right one is how a rider gets the right direction.
   * The selected stop always wins both rules; it is the one being read about in
   * the sheet below.
   */
  const stopPlacements = useMemo(() => {
    const source: Stop[] = route ? route.stops : nearbyStops;
    if (tier !== 'near') {
      return source.map((stop) => ({ stop, labelled: stop.id === selectedStopId }));
    }

    const cellLat = (visibleRegion.latitudeDelta * STOP_LABEL_CELL) / Math.max(1, viewport.height);
    const cellLon = (visibleRegion.longitudeDelta * STOP_LABEL_CELL) / Math.max(1, viewport.width);
    const takenCells = new Set<string>();
    const takenNames = new Set<string>();

    // Sorted by id so the platform that carries the name is the same one from
    // poll to poll; the selected stop is considered first so it always wins.
    const ordered = source
      .slice()
      .sort((a, b) => (a.id === selectedStopId ? -1 : b.id === selectedStopId ? 1 : a.id < b.id ? -1 : 1));

    return ordered.map((stop) => {
      const selected = stop.id === selectedStopId;
      const cell = `${Math.round(stop.lat / cellLat)}:${Math.round(stop.lon / cellLon)}`;
      const free = !takenNames.has(stop.name) && !takenCells.has(cell);
      if (free) {
        takenNames.add(stop.name);
        takenCells.add(cell);
      }
      return { stop, labelled: free || selected };
    });
  }, [nearbyStops, route, selectedStopId, tier, viewport.height, viewport.width, visibleRegion]);

  const osm = mapProvider === 'osm';
  // On iOS the system map is MapKit: let the rider pick its base style. On
  // Android the system map is Google's, which stays standard. OSM always rides
  // on a standard base and tiles over it.
  const mapType: MapType = Platform.select<MapType>({
    ios: osm ? 'standard' : appleMapType,
    android: osm ? 'none' : 'standard',
    default: 'standard',
  }) ?? 'standard';

  return (
    <Maps
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      // Uncontrolled: feeding the region back on every pan fights the rider's
      // own gestures and makes the map stutter.
      initialRegion={INITIAL_REGION}
      onRegionChangeComplete={handleRegionChange}
      onPress={onBackground}
      showsUserLocation={Boolean(userPosition)}
      showsMyLocationButton={false}
      showsCompass={false}
      showsScale={false}
      showsIndoors={false}
      toolbarEnabled={false}
      pitchEnabled={false}
      rotateEnabled={false}
      userInterfaceStyle={dark ? 'dark' : 'light'}
      // Android draws the raster tiles over its own base map unless the base
      // map is switched off; iOS does it through the tile layer instead.
      mapType={mapType}>
      {osm && (
        <UrlTile
          urlTemplate={`https://a.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}@2x.png`}
          maximumZ={20}
          shouldReplaceMapContent
          zIndex={-1}
        />
      )}

      {routeCoordinates.length > 1 && route && (
        <>
          <Polyline
            coordinates={routeCoordinates}
            strokeColor={dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)'}
            strokeWidth={6}
            lineJoin="round"
            lineCap="round"
            zIndex={0}
          />
          {split ? (
            <>
              {travelledCoordinates && travelledCoordinates.length > 1 && (
                <Polyline
                  coordinates={travelledCoordinates}
                  strokeColor={fadeColor(route.color, 0.24)}
                  strokeWidth={3}
                  lineJoin="round"
                  lineCap="round"
                  zIndex={1}
                />
              )}
              <Polyline
                coordinates={remainingCoordinates ?? routeCoordinates}
                strokeColor={route.color}
                strokeWidth={4}
                lineJoin="round"
                lineCap="round"
                zIndex={1}
              />
            </>
          ) : (
            <Polyline
              coordinates={routeCoordinates}
              strokeColor={route.color}
              strokeWidth={4}
              lineJoin="round"
              lineCap="round"
              zIndex={1}
            />
          )}
        </>
      )}

      {/* A route's own stops replace the nearby ones while there is a route,
          the same way those two layers trade places everywhere else. */}
      {stopPlacements.map(({ stop, labelled }) => (
        <StopMarker
          key={`stop-${stop.id}`}
          stop={stop}
          tint={route?.color ?? STOP_TINT}
          labelled={labelled}
          selected={stop.id === selectedStopId}
          onDark={scheme === 'dark'}
          onPress={handleStop}
        />
      ))}

      {placements.map(({ vehicle, labelled, dotSize, dotTail }) => (
        <VehicleMarker
          key={vehicle.id}
          vehicle={vehicle}
          // While a route is drawn, everything not running it steps back.
          dimmed={Boolean(selected) && vehicle.line !== selected?.line}
          selected={vehicle.id === selectedVehicleId}
          labelled={labelled}
          dotSize={dotSize}
          dotTail={dotTail}
          glide={!reducedMotion}
          onPress={onSelectVehicle}
        />
      ))}
    </Maps>
  );
});

/** Whether this build can offer the platform's own map at all. */
export const nativeMapAvailable = true;

const ANCHOR_CENTRE: MapMarkerProps['anchor'] = { x: 0.5, y: 0.5 };
const APPLE_CENTRE_OFFSET: NonNullable<MapMarkerProps['centerOffset']> = { x: 0, y: 0 };

/**
 * A stop with no route drawn.
 *
 * Nearly black rather than the grey this used to be: a grey ring around a white
 * dot vanished into satellite imagery, which is the one base map where a stop
 * marker most needs to be visible.
 */
const STOP_TINT = '#1C1C1E';

/**
 * The labelled stop marker's box.
 *
 * The dot sits on the coordinate and the name hangs under it, so the marker's
 * anchor has to be the dot's centre and not the middle of the box — otherwise
 * every named stop is drawn half a label north of where it actually is.
 * Android reads that as a normalized `anchor`, MapKit as a pixel
 * `centerOffset`, so the geometry is written once here and converted for each.
 */
const STOP_DOT = 13;
const STOP_LABEL_GAP = 2;
const STOP_NAME_HEIGHT = 14;
const STOP_LABEL_WIDTH = 104;
const STOP_LABEL_HEIGHT = 42;
const STOP_LABEL_PAD = (STOP_LABEL_HEIGHT - STOP_DOT - STOP_LABEL_GAP - STOP_NAME_HEIGHT) / 2;
/** Where the dot's centre falls inside that box. */
const STOP_DOT_CENTRE_Y = STOP_LABEL_PAD + STOP_DOT / 2;
const STOP_LABEL_ANCHOR: MapMarkerProps['anchor'] = {
  x: 0.5,
  y: STOP_DOT_CENTRE_Y / STOP_LABEL_HEIGHT,
};
const STOP_LABEL_OFFSET: NonNullable<MapMarkerProps['centerOffset']> = {
  x: 0,
  y: Math.round(STOP_DOT_CENTRE_Y - STOP_LABEL_HEIGHT / 2),
};

const styles = StyleSheet.create({
  vehicleDimmed: { opacity: 0.28 },

  /** Fills the marker box, so it turns about the badge's centre. */
  tailLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
  },
  tail: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: TAIL_HALF_BASE,
    borderRightWidth: TAIL_HALF_BASE,
    borderBottomWidth: TAIL_LENGTH,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    backgroundColor: 'transparent',
  },
  /**
   * The white keyline, continuing the badge's own border around the tail — the
   * seam between them is what would give the fusion away, and a tinted arrow
   * on its own vanishes over a road drawn in roughly that colour.
   */
  tailOutline: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: TAIL_HALF_BASE + TAIL_OUTLINE,
    borderRightWidth: TAIL_HALF_BASE + TAIL_OUTLINE,
    borderBottomWidth: TAIL_LENGTH + TAIL_OUTLINE,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#ffffff',
    backgroundColor: 'transparent',
  },

  /** The same tail, at the size a 12pt dot can carry rather than a badge. */
  dotTail: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: DOT_TAIL_HALF_BASE,
    borderRightWidth: DOT_TAIL_HALF_BASE,
    borderBottomWidth: DOT_TAIL_LENGTH,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    backgroundColor: 'transparent',
  },
  dotTailOutline: {
    position: 'absolute',
    width: 0,
    height: 0,
    borderLeftWidth: DOT_TAIL_HALF_BASE + DOT_TAIL_OUTLINE,
    borderRightWidth: DOT_TAIL_HALF_BASE + DOT_TAIL_OUTLINE,
    borderBottomWidth: DOT_TAIL_LENGTH + DOT_TAIL_OUTLINE,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#ffffff',
    backgroundColor: 'transparent',
  },

  // Width, height and radius come from the geometry: a pill for a bus, square
  // shoulders for a tram, and both a little larger when selected. Shape carries
  // the mode as well as colour — two hues alone are no help to anyone who
  // cannot separate them, and this map is read in sunlight.
  badge: {
    paddingHorizontal: 5,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    ...Elevation.marker,
  },
  /**
   * The selected vehicle grows by real points rather than by a transform: a
   * scaled badge slides away from the tail joined to it, which is the one seam
   * this marker cannot afford. The extra shadow is what lifts it off the fleet.
   */
  badgeSelected: Platform.select({
    ios: { shadowOpacity: 0.45, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    android: { elevation: 8 },
    default: { boxShadow: '0 2px 10px rgba(0,0,0,0.45)' },
  }) as object,

  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: Weight.heavy,
    lineHeight: 16,
    letterSpacing: -0.3,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  labelLong: { fontSize: 11, letterSpacing: -0.5 },

  // Size, radius and ring all come from the geometry: the tier sets the first,
  // and at city zoom so does how many vehicles the dot stands for.
  dot: {
    borderColor: '#ffffff',
    ...Elevation.marker,
  },

  // Keep the measured marker bounds fixed. The label is allowed to extend
  // beyond this compact coordinate box without changing the map anchor.
  stopWrapper: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  stopLabelled: {
    width: STOP_LABEL_WIDTH,
    height: STOP_LABEL_HEIGHT,
    alignItems: 'center',
    paddingTop: STOP_LABEL_PAD,
  },
  stopDot: {
    width: STOP_DOT,
    height: STOP_DOT,
    borderRadius: Radius.pill,
    backgroundColor: '#ffffff',
    borderWidth: 3.5,
    ...Elevation.marker,
  },
  stopDotSelected: { transform: [{ scale: 1.25 }], borderWidth: 4 },
  stopName: {
    marginTop: STOP_LABEL_GAP,
    maxWidth: STOP_LABEL_WIDTH,
    height: STOP_NAME_HEIGHT,
    fontSize: 11,
    lineHeight: STOP_NAME_HEIGHT,
    fontWeight: Weight.semibold,
    letterSpacing: -0.1,
    textAlign: 'center',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
  stopNameOnDark: { color: '#ffffff', textShadowColor: 'rgba(0,0,0,0.95)' },
  stopNameOnLight: { color: '#1C1C1E', textShadowColor: 'rgba(255,255,255,0.95)' },
  stopNameSelected: { fontWeight: Weight.heavy },
});
