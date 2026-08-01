// Preview-only stand-in: react-native-maps is native-only, so the browser can
// never render the real map. Everything else in the UI is real.
//
// It forwards a ref and answers the imperative calls MapView makes
// (`fitToCoordinates`, `animateToRegion`) with no-ops. Without that, React logs
// a warning about a ref on a function component every time the preview loads,
// which buries whatever you were actually trying to see in the console.
import { forwardRef, useImperativeHandle } from 'react';
import { View } from 'react-native';

export const Marker = () => null;
export const Polyline = () => null;
export const Callout = () => null;

export default forwardRef(function Maps({ style, children }, ref) {
  useImperativeHandle(ref, () => ({
    fitToCoordinates: () => {},
    animateToRegion: () => {},
    animateCamera: () => {},
  }));

  return <View style={[style, { backgroundColor: '#DCE5EC' }]}>{children}</View>;
});
