// Preview-only stand-in: react-native-maps is native-only, so the browser can
// never render the real map. Everything else in the UI is real.
//
// It forwards a ref and answers the imperative calls MapView makes
// (`fitToCoordinates`, `animateToRegion`) with no-ops. Without that, React logs
// a warning about a ref on a function component every time the preview loads,
// which buries whatever you were actually trying to see in the console.
//
// Markers render as a plain strip of pressable chips along the top of the grey
// box rather than as nothing. There is no map projection here to place them on,
// but returning null made everything reached by tapping a marker — the route
// banner, the departures board, the vehicle's stop list — impossible to see in
// the preview at all. Their positions are meaningless; their taps are real.
import { forwardRef, useImperativeHandle } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

export const Marker = ({ children, onPress, accessibilityLabel }) => (
  <Pressable
    onPress={onPress}
    accessibilityLabel={accessibilityLabel}
    accessibilityRole="button"
    style={{ margin: 3 }}
  >
    {children}
  </Pressable>
);

export const Polyline = () => null;
export const Callout = () => null;

export default forwardRef(function Maps({ style, children }, ref) {
  useImperativeHandle(ref, () => ({
    fitToCoordinates: () => {},
    animateToRegion: () => {},
    animateCamera: () => {},
  }));

  return (
    <View style={[style, { backgroundColor: '#DCE5EC' }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ position: 'absolute', top: 120, left: 0, right: 0, maxHeight: 64 }}
        contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}
      >
        {children}
      </ScrollView>
    </View>
  );
});
