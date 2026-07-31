// Preview-only stand-in: react-native-maps is native-only, so the browser can
// never render the real map. Everything else in the UI is real.
import { View } from 'react-native';
export const Marker = () => null;
export const Polyline = () => null;
export const Callout = () => null;
export default function Maps({ style, children }) {
  return <View style={[style, { backgroundColor: '#DCE5EC' }]}>{children}</View>;
}
