import { useEffect, useRef, useState } from 'react';

import type { MapViewport } from '@/components/map-surface.types';
import { getStopsNear, type Stop } from '@/lib/api';
import { distanceMeters } from '@/lib/stops-api';

/**
 * Below this the map is showing districts, not streets.
 *
 * Every stop in Wrocław at city zoom is a few thousand dots, none of which can
 * carry a name at that scale — so the layer simply is not drawn, and the map
 * goes back to being about where the vehicles are.
 */
const MIN_ZOOM = 14;

/** Never ask for more than a walk across a district, however far out the map is. */
const MAX_RADIUS_METERS = 2_000;

/** The server caps at 100; asking for the cap keeps a dense centre complete. */
const MAX_STOPS = 100;

/** Let the rider finish the gesture before spending a request on it. */
const SETTLE_MS = 350;

/**
 * How far the viewport has to move before the answer could have changed.
 *
 * A pan of a few metres — which every inertia scroll produces — returns the
 * same stops, so refetching on it is pure waste and makes the layer flicker.
 */
const MOVE_FRACTION = 0.4;
const ZOOM_FRACTION = 0.35;

/**
 * The stops inside what the map is showing.
 *
 * This is the layer that used to appear only after the locate button was
 * pressed, which meant panning to a district you were not standing in showed
 * you nothing at all. It follows the viewport instead: zoom in anywhere and the
 * stops are there.
 *
 * The previous result is kept while a new one is in flight, so the layer never
 * blinks empty mid-pan.
 */
export function useAreaStops(viewport: MapViewport | null, enabled: boolean): Stop[] {
  const [stops, setStops] = useState<Stop[]>(EMPTY);

  /** What the stops on screen were fetched for, so a small pan changes nothing. */
  const fetchedFor = useRef<MapViewport | null>(null);

  const active = enabled && viewport !== null && viewport.zoom >= MIN_ZOOM;

  useEffect(() => {
    if (!active || !viewport) {
      fetchedFor.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStops((current) => (current.length ? EMPTY : current));
      return;
    }

    if (!worthRefetching(fetchedFor.current, viewport)) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      const radius = Math.min(viewport.radiusMeters, MAX_RADIUS_METERS);
      getStopsNear(viewport.lat, viewport.lon, radius, {
        signal: controller.signal,
        limit: MAX_STOPS,
        // A stops request that lands in the boot window is not worth holding
        // open: the next pan will ask again.
        retryWhileLoading: false,
      })
        .then((next) => {
          if (controller.signal.aborted) return;
          fetchedFor.current = { ...viewport, radiusMeters: radius };
          setStops(next.length ? next : EMPTY);
        })
        .catch(() => {
          // The map is still a map without its stop names. An abort lands here
          // too and is just as fine.
        });
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, viewport]);

  return active ? stops : EMPTY;
}

function worthRefetching(previous: MapViewport | null, next: MapViewport) {
  if (!previous) return true;
  if (Math.abs(next.zoom - previous.zoom) > ZOOM_FRACTION) return true;
  const moved = distanceMeters(previous.lat, previous.lon, next.lat, next.lon);
  return moved > previous.radiusMeters * MOVE_FRACTION;
}

// A stable empty array: a new `[]` each render would re-run every effect that
// pushes stops into the map.
const EMPTY: Stop[] = [];
