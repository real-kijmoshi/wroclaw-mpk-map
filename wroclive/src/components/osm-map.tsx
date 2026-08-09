import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

import { LiveMap } from './live-map';
import type { LiveMapHandle } from './live-map.types';
import type { MapSurfaceHandle, MapSurfaceProps } from './map-surface.types';
import type { MapMessage } from '@/lib/map-html';

/**
 * The OpenStreetMap surface: the Leaflet page, given the same declarative
 * props as Apple's map.
 *
 * The page itself stays imperative — it moves markers rather than rebuilding
 * them, which is the whole reason the fleet does not blink every ten seconds —
 * so this translates prop changes into the commands it expects, one effect per
 * kind of change so nothing is re-sent when something unrelated moves.
 */
export const OsmMap = forwardRef<MapSurfaceHandle, MapSurfaceProps>(function OsmMap(
  {
    dark,
    vehicles,
    route,
    selectedVehicleId,
    follow = false,
    fitRoute = false,
    userPosition,
    nearbyStops,
    onSelectVehicle,
    onSelectStop,
    onBackground,
  },
  ref,
) {
  const mapRef = useRef<LiveMapHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      centerOn(lat, lon, zoom) {
        mapRef.current?.send({ type: 'center', lat, lon, zoom });
      },
    }),
    [],
  );

  useEffect(() => {
    mapRef.current?.send({ type: 'vehicles', vehicles });
  }, [vehicles]);

  useEffect(() => {
    mapRef.current?.send({ type: 'theme', dark });
  }, [dark]);

  useEffect(() => {
    // Drawing a selected vehicle's route must not take over the viewport.
    mapRef.current?.send({ type: 'route', shape: route ? { ...route, fit: fitRoute } : null });
  }, [route, fitRoute]);

  useEffect(() => {
    // A route's own stops own the layer while there is one; the nearby stops
    // would otherwise clear them.
    if (route) return;
    mapRef.current?.send({ type: 'stops', stops: nearbyStops });
  }, [nearbyStops, route]);

  useEffect(() => {
    mapRef.current?.send({ type: 'user', position: userPosition });
  }, [userPosition]);

  useEffect(() => {
    mapRef.current?.send({ type: 'select', id: selectedVehicleId, follow, center: follow });
  }, [selectedVehicleId, follow]);

  const handleMessage = useCallback(
    (message: MapMessage) => {
      switch (message.type) {
        case 'vehicle':
          onSelectVehicle(message.id);
          break;
        case 'stop':
          // The bridge only sends the marker id. Recover the full record so a
          // merged platform keeps its sibling ids and coordinates when its
          // departure board opens.
          onSelectStop(
            (route?.stops ?? nearbyStops).find((stop) => stop.id === message.id) ?? {
              id: message.id,
              name: message.name,
              lat: 0,
              lon: 0,
            },
          );
          break;
        case 'background':
          onBackground();
          break;
        default:
          break;
      }
    },
    [nearbyStops, onSelectVehicle, onSelectStop, onBackground, route],
  );

  return <LiveMap ref={mapRef} dark={dark} onMessage={handleMessage} />;
});
