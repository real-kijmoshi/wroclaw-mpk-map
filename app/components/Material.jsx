import { View } from "react-native";

import { material } from "../theme";

/**
 * A translucent surface, the way iOS floats a bar over content.
 *
 * On the web this is a real backdrop blur — react-native-web forwards
 * `backdropFilter` to CSS — so the tab bar and the status pill pick up the map
 * moving underneath them. On a device it degrades to the same tint at a higher
 * opacity rather than pulling in a native blur view; see `material` in
 * theme.js.
 */
export default function Material({ tint = "light", style, children, ...rest }) {
  return (
    <View style={[material[tint] ?? material.light, style]} {...rest}>
      {children}
    </View>
  );
}
