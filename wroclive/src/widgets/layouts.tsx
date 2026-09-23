import { HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  background,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  monospacedDigit,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, createWidget, type LiveActivityEnvironment, type WidgetEnvironment } from 'expo-widgets';

/**
 * The home-screen widget and the Live Activity, drawn by WidgetKit.
 *
 * Read this before editing: every function marked `'widget'` is compiled to a
 * *string* (babel-preset-expo's widgets plugin) and evaluated inside the widget
 * extension, where `@expo/ui`'s views and modifiers are globals. So a layout
 * may use those names exactly as imported here — no aliases — and nothing
 * else from this module or the app: no helper, no constant, no theme import.
 * Anything it needs, colours included, arrives in its props, which is why the
 * app computes them (`src/lib/widgets.ios.ts`) and the layout only draws.
 *
 * Only `src/lib/widgets.ios.ts` requires this file, and only when the native
 * module is present: importing `expo-widgets` resolves its native module at
 * module scope, which is a crash in Expo Go.
 */

export type DeparturesWidgetRow = {
  line: string;
  /** Line colour, from `colorFor()`; clears 4.5:1 with white (invariant 11). */
  color: string;
  headsign: string;
  /** Epoch ms the departure leaves. */
  at: number;
  realtime: boolean;
};

export type DeparturesWidgetProps = {
  /** Null when nothing is starred yet. */
  stopName: string | null;
  rows: DeparturesWidgetRow[];
  /** `wroclive://open?stop=…`, so a tap opens that stop's board. */
  url: string;
  /** `theme.amber` for each scheme — the countdown colour and nothing else (invariant 10). */
  amberLight: string;
  amberDark: string;
};

export type ArrivalActivityProps = {
  line: string;
  color: string;
  towards: string | null;
  stopName: string;
  /** Epoch ms the vehicle is expected at the stop. */
  arrivesAt: number;
  /** Epoch ms of the fix the estimate came from — where the countdown starts. */
  since: number;
  atStop: boolean;
  amberLight: string;
  amberDark: string;
};

const DeparturesWidget = (props: DeparturesWidgetProps, environment: WidgetEnvironment) => {
  'widget';
  const amber = environment.colorScheme === 'dark' ? props?.amberDark : props?.amberLight;
  const now = environment.date.getTime();
  const small = environment.widgetFamily === 'systemSmall';

  if (!props || !props.stopName) {
    return (
      <VStack alignment="leading" spacing={4} modifiers={[padding({ all: 4 })]}>
        <Text modifiers={[font({ textStyle: 'headline' })]}>Wroclive</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          Dodaj przystanek do ulubionych w aplikacji, a tu pojawią się jego odjazdy.
        </Text>
      </VStack>
    );
  }

  // The timeline repeats the same rows every minute; each entry drops what has
  // already left and counts the rest from its own date, so the widget keeps
  // counting while the app is closed.
  const upcoming = props.rows.filter((row) => row.at >= now - 30_000).slice(0, small ? 3 : 4);

  return (
    <VStack alignment="leading" spacing={6} modifiers={[widgetURL(props.url)]}>
      <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>
        {props.stopName}
      </Text>
      {upcoming.length === 0 ? (
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          Otwórz aplikację, aby odświeżyć odjazdy.
        </Text>
      ) : (
        upcoming.map((row) => {
          const minutes = Math.round((row.at - now) / 60_000);
          return (
            <HStack key={`${row.line}-${row.at}`} spacing={6}>
              <Text
                modifiers={[
                  font({ size: 12, weight: 'bold' }),
                  foregroundStyle('#FFFFFF'),
                  padding({ horizontal: 5, vertical: 1 }),
                  frame({ minWidth: 26 }),
                  background(row.color),
                  cornerRadius(5),
                ]}>
                {row.line}
              </Text>
              {!small && (
                <Text modifiers={[font({ textStyle: 'footnote' }), lineLimit(1)]}>{row.headsign}</Text>
              )}
              <Spacer />
              <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), monospacedDigit(), foregroundStyle(amber)]}>
                {minutes < 1 ? 'teraz' : `${minutes} min`}
              </Text>
            </HStack>
          );
        })
      )}
      <Spacer />
    </VStack>
  );
};

const ArrivalActivity = (props: ArrivalActivityProps, environment: LiveActivityEnvironment) => {
  'widget';
  const amber = environment.colorScheme === 'dark' ? props.amberDark : props.amberLight;
  const stale = Boolean(environment.isStale);
  const badge = (
    <Text
      modifiers={[
        font({ size: 15, weight: 'bold' }),
        foregroundStyle('#FFFFFF'),
        padding({ horizontal: 6, vertical: 2 }),
        background(props.color),
        cornerRadius(6),
      ]}>
      {props.line}
    </Text>
  );
  // A native timer: it keeps counting on the lock screen with the app
  // suspended. When the app can no longer refresh it the system marks the
  // activity stale, and the countdown steps back rather than claim precision.
  const countdown = props.atStop ? (
    <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(amber)]}>jest</Text>
  ) : (
    <Text
      timerInterval={{ lower: new Date(props.since), upper: new Date(props.arrivesAt) }}
      countsDown
      modifiers={[
        font({ textStyle: 'headline' }),
        monospacedDigit(),
        foregroundStyle(stale ? { type: 'hierarchical', style: 'secondary' } : amber),
        frame({ maxWidth: 64, alignment: 'trailing' }),
      ]}
    />
  );
  const title = props.towards ? `${props.line} → ${props.towards}` : `Linia ${props.line}`;
  const subtitle = props.atStop ? `Na przystanku ${props.stopName}` : `Do przystanku ${props.stopName}`;

  return {
    banner: (
      <HStack spacing={10} modifiers={[padding({ all: 14 })]}>
        {badge}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1)]}>{title}</Text>
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>
            {subtitle}
          </Text>
        </VStack>
        <Spacer />
        {countdown}
      </HStack>
    ),
    compactLeading: badge,
    compactTrailing: countdown,
    minimal: (
      <Text modifiers={[font({ size: 12, weight: 'bold' }), foregroundStyle(props.color)]}>{props.line}</Text>
    ),
    expandedLeading: badge,
    expandedTrailing: countdown,
    expandedBottom: (
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>
        {subtitle}
      </Text>
    ),
  };
};

export const departuresWidget = createWidget<DeparturesWidgetProps>('Departures', DeparturesWidget);
export const arrivalActivity = createLiveActivity<ArrivalActivityProps>('Arrival', ArrivalActivity);
