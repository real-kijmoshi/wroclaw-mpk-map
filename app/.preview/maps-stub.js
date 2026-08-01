/**
 * Preview-only stand-in for react-native-maps.
 *
 * The real library is native-only, so a browser can never render the actual
 * map. Metro swaps this in for the web platform only (see metro.config.js) —
 * nothing here ships in an iOS or Android build.
 *
 * It used to render an empty grey box, which meant everything reached through
 * a marker — the route banner, the departures board, stop selection — could not
 * be opened in a browser at all. So it now does the least possible thing that
 * makes those paths clickable: a flat equirectangular projection of the current
 * region onto the box, markers placed on it, and the handful of imperative
 * methods the app calls on the map ref. Distances are visibly wrong and there
 * are no tiles. It is a harness, not a map.
 */
import { createContext, forwardRef, useContext, useImperativeHandle, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

const RegionContext = createContext(null);

const project = (region, size, latitude, longitude) => ({
  left: ((longitude - region.longitude) / region.longitudeDelta + 0.5) * size.width,
  top: (0.5 - (latitude - region.latitude) / region.latitudeDelta) * size.height,
});

export const Marker = ({ coordinate, children, onPress, anchor = { x: 0.5, y: 0.5 } }) => {
  const context = useContext(RegionContext);
  if (!context || !coordinate) return null;

  const { left, top } = project(
    context.region,
    context.size,
    coordinate.latitude,
    coordinate.longitude,
  );
  if (left < -40 || top < -40 || left > context.size.width + 40 || top > context.size.height + 40) {
    return null;
  }

  return (
    <Pressable
      onPress={onPress}
      style={{
        position: 'absolute',
        left,
        top,
        transform: [{ translateX: -anchor.x * 28 }, { translateY: -anchor.y * 28 }],
      }}
    >
      {children}
    </Pressable>
  );
};

export const Polyline = ({ coordinates, strokeColor }) => {
  const context = useContext(RegionContext);
  if (!context || !coordinates?.length) return null;

  // Dots rather than a stroke: enough to see the shape came back and covers
  // the right streets, without pulling SVG into the preview.
  return coordinates
    .filter((_, index) => index % 4 === 0)
    .map((coordinate, index) => {
      const { left, top } = project(
        context.region,
        context.size,
        coordinate.latitude,
        coordinate.longitude,
      );
      return (
        <View
          key={index}
          style={{
            position: 'absolute',
            left: left - 2,
            top: top - 2,
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: strokeColor,
          }}
        />
      );
    });
};

export const Callout = () => null;

export default forwardRef(function Maps(
  { style, children, initialRegion, onRegionChangeComplete, onPress },
  ref,
) {
  const [region, setRegion] = useState(initialRegion);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useImperativeHandle(ref, () => ({
    animateToRegion: (next) => {
      setRegion(next);
      onRegionChangeComplete?.(next);
    },
    fitToCoordinates: (coordinates) => {
      if (!coordinates?.length) return;
      const lats = coordinates.map((c) => c.latitude);
      const lons = coordinates.map((c) => c.longitude);
      const next = {
        latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
        longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
        latitudeDelta: Math.max(Math.max(...lats) - Math.min(...lats), 0.01) * 1.4,
        longitudeDelta: Math.max(Math.max(...lons) - Math.min(...lons), 0.01) * 1.4,
      };
      setRegion(next);
      onRegionChangeComplete?.(next);
    },
    fitToElements: () => {},
    getMapBoundaries: async () => ({}),
  }));

  const context = useMemo(() => ({ region, size }), [region, size]);

  return (
    <View
      style={[style, styles.canvas]}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onPress} />
      <RegionContext.Provider value={context}>
        {size.width > 0 ? children : null}
      </RegionContext.Provider>
    </View>
  );
});

const styles = StyleSheet.create({
  canvas: { backgroundColor: '#DCE5EC', overflow: 'hidden' },
});
