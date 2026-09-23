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
};

export type DeparturesWidgetStop = {
  name: string;
  /** `wroclive://open?stop=…`, so a tap opens that stop's board. */
  url: string;
  /** Walking time from where the rider last was, or null when unknown or too far. */
  walk: number | null;
  rows: DeparturesWidgetRow[];
};

export type DeparturesWidgetProps = {
  /** The first three starred stops; the widget's configuration picks one. */
  stops: DeparturesWidgetStop[];
  /** `theme.amber` for each scheme — the countdown colour and nothing else (invariant 10). */
  amberLight: string;
  amberDark: string;
};

/** The widget's configuration menu (`app.json`): which favourite it shows. */
export type DeparturesWidgetConfiguration = { slot?: 'first' | 'second' | 'third' };

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

const DeparturesWidget = (
  props: DeparturesWidgetProps,
  environment: WidgetEnvironment<DeparturesWidgetConfiguration>,
) => {
  'widget';
  const family = environment.widgetFamily;
  const lockScreen = family.startsWith('accessory');
  const amber = environment.colorScheme === 'dark' ? props?.amberDark : props?.amberLight;
  const now = environment.date.getTime();
  const slot = environment.configuration?.slot === 'third' ? 2 : environment.configuration?.slot === 'second' ? 1 : 0;
  const stops = props?.stops ?? [];
  const stop = stops[slot] ?? stops[0];

  if (!stop) {
    return lockScreen ? (
      <Text modifiers={[font({ textStyle: 'caption' })]}>Dodaj ulubiony przystanek</Text>
    ) : (
      <VStack alignment="leading" spacing={4}>
        <Text modifiers={[font({ textStyle: 'headline' })]}>Wroclive</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          Dodaj przystanek do ulubionych w aplikacji, a tu pojawią się jego odjazdy.
        </Text>
      </VStack>
    );
  }

  // The timeline repeats the same rows once a minute; each entry drops what
  // has left and counts the rest from its own date, so the widget keeps going
  // with the app closed. A departure the walk cannot reach stays listed —
  // it is on the board at the stop too — but its minutes step back.
  const upcoming = stop.rows.filter((row) => row.at >= now - 30_000);
  const minutesTo = (row: DeparturesWidgetRow) => Math.max(0, Math.round((row.at - now) / 60_000));
  const label = (row: DeparturesWidgetRow) => (minutesTo(row) < 1 ? 'teraz' : `${minutesTo(row)} min`);
  const reachable = (row: DeparturesWidgetRow) => stop.walk === null || row.at - now >= (stop.walk + 30) * 1_000;

  if (family === 'accessoryInline') {
    const next = upcoming[0];
    return (
      <Text modifiers={[widgetURL(stop.url)]}>
        {next ? `${next.line} · ${label(next)} · ${stop.name}` : stop.name}
      </Text>
    );
  }

  if (family === 'accessoryCircular') {
    const next = upcoming.find(reachable) ?? upcoming[0];
    return (
      <VStack spacing={0} modifiers={[widgetURL(stop.url)]}>
        <Text modifiers={[font({ size: 13, weight: 'bold' })]}>{next ? next.line : '—'}</Text>
        <Text modifiers={[font({ size: 11 }), monospacedDigit()]}>{next ? label(next) : ''}</Text>
      </VStack>
    );
  }

  if (family === 'accessoryRectangular') {
    return (
      <VStack alignment="leading" spacing={1} modifiers={[widgetURL(stop.url)]}>
        <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), lineLimit(1)]}>{stop.name}</Text>
        {upcoming.slice(0, 2).map((row) => (
          <HStack key={`${row.line}-${row.at}`} spacing={4}>
            <Text modifiers={[font({ textStyle: 'caption', weight: 'bold' })]}>{row.line}</Text>
            <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1)]}>{row.headsign}</Text>
            <Spacer />
            <Text modifiers={[font({ textStyle: 'caption' }), monospacedDigit()]}>{label(row)}</Text>
          </HStack>
        ))}
      </VStack>
    );
  }

  const small = family === 'systemSmall';
  const shown = upcoming.slice(0, small ? 3 : 4);
  const walkMinutes = stop.walk === null ? null : Math.max(1, Math.round(stop.walk / 60));

  return (
    <VStack alignment="leading" spacing={6} modifiers={[widgetURL(stop.url)]}>
      <HStack spacing={4}>
        <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>
          {stop.name}
        </Text>
        <Spacer />
        {walkMinutes !== null && !small && (
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
            {`${walkMinutes} min pieszo`}
          </Text>
        )}
      </HStack>
      {shown.length === 0 ? (
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          Otwórz aplikację, aby odświeżyć odjazdy.
        </Text>
      ) : (
        shown.map((row) => (
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
            {!small && <Text modifiers={[font({ textStyle: 'footnote' }), lineLimit(1)]}>{row.headsign}</Text>}
            <Spacer />
            <Text
              modifiers={[
                font({ textStyle: 'footnote', weight: 'semibold' }),
                monospacedDigit(),
                foregroundStyle(reachable(row) ? amber : { type: 'hierarchical', style: 'tertiary' }),
              ]}>
              {label(row)}
            </Text>
          </HStack>
        ))
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

export const departuresWidget = createWidget<DeparturesWidgetProps, DeparturesWidgetConfiguration>(
  'Departures',
  DeparturesWidget,
);
export const arrivalActivity = createLiveActivity<ArrivalActivityProps>('Arrival', ArrivalActivity);
