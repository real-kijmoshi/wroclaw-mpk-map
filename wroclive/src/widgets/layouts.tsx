import {
  AccessoryWidgetBackground,
  HStack,
  Image,
  ProgressView,
  Spacer,
  Text,
  VStack,
  ZStack,
} from '@expo/ui/swift-ui';
import {
  background,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  padding,
  shapes,
  tint,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, createWidget, type LiveActivityEnvironment, type WidgetEnvironment } from 'expo-widgets';

/**
 * The home-screen widget and the Live Activities, drawn by WidgetKit.
 *
 * Read this before editing: every function marked `'widget'` is compiled to a
 * *string* (babel-preset-expo's widgets plugin) and evaluated inside the widget
 * extension, where `@expo/ui`'s views and modifiers are globals. So a layout
 * may use those names exactly as imported here — no aliases — and nothing
 * else from this module or the app: no helper, no constant, no theme import.
 * A helper a layout needs is declared *inside* it, where it becomes part of
 * the string. Syntax that Babel lowers to a helper — rest destructuring, for
 * one — breaks the same way, because the helper is not in the string either. Anything else, colours included, arrives in its props, which is
 * why the app computes them (`src/lib/widgets.ios.ts`) and the layout only
 * draws.
 *
 * Only `src/lib/widgets.ios.ts` requires this file, and only when the native
 * module is present: importing `expo-widgets` resolves its native module at
 * module scope, which is a crash in Expo Go.
 */

export type DeparturesWidgetRow = {
  line: string;
  /** Line colour, from `colorFor()`; clears 4.5:1 with white (invariant 11). */
  color: string;
  tram: boolean;
  headsign: string;
  /** Epoch ms the departure leaves. */
  at: number;
  /** `at` as the rider's wall clock, "22:41" — what the last entry shows. */
  clock: string;
  /** A live prediction rather than the timetable. */
  live: boolean;
  /** Saved trips only: when this departure reaches the destination. */
  arriveAt?: number | null;
  arriveClock?: string | null;
};

export type DeparturesWidgetStop = {
  /**
   * A starred stop's board, or a saved trip — the board of its origin with
   * only the departures that reach the destination, each with its arrival.
   */
  kind: 'stop' | 'trip';
  /** A stop's id, or `trip:<id>`. */
  id: string;
  /** Saved trips only: where it goes. */
  destination?: string;
  name: string;
  /** The rider's own name for it ("Dom"), or null. */
  label: string | null;
  /** Where it goes from here — "→ Oporów, Leśnica" — which tells two platforms apart. */
  detail: string;
  /** `wroclive://open?stop=…`, so a tap opens that stop's board. */
  url: string;
  /** Walking time from where the rider last was, or null when unknown or too far. */
  walk: number | null;
  rows: DeparturesWidgetRow[];
};

export type DeparturesWidgetProps = {
  /** Every starred stop, in the rider's order. */
  stops: DeparturesWidgetStop[];
  /**
   * The same stops as the widget's "Przystanek" setting lists them — read by
   * the Swift query `plugins/with-widget-stop-picker.js` adds, from the first
   * timeline entry.
   */
  favourites: { id: string; name: string; detail: string }[];
  /** When the boards were fetched. */
  updatedAt: number;
  /** The timeline's last entry: nothing will redraw it, so it shows clock times, not countdowns. */
  final: boolean;
  /** `theme.amber` for each scheme — the countdown colour and nothing else (invariant 10). */
  amberLight: string;
  amberDark: string;
};

/**
 * The widget's configuration: a starred stop's id, from the picker the config
 * plugin adds. Without that plugin it is a text field, so a typed name matches
 * too. Empty means "the first starred stop".
 */
export type DeparturesWidgetConfiguration = { stop?: string };

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

/** A rider on board, counting down to the stop they get off at. */
export type TripActivityProps = ArrivalActivityProps & {
  /** Stops still to come, the destination included; 0 once there. */
  stopsAway: number;
  /** How many there were when the ride was started — the progress bar's whole. */
  totalStops: number;
  /** The next stop the vehicle reaches, as the tram's own display would say it. */
  nextStop: string;
};

const DeparturesWidget = (
  props: DeparturesWidgetProps,
  environment: WidgetEnvironment<DeparturesWidgetConfiguration>,
) => {
  'widget';
  const family = environment.widgetFamily;
  const lockScreen = family.startsWith('accessory');
  // Tinted and clear home screens, and the lock screen, recolour everything:
  // a filled badge there is a grey slab with the number knocked out of it.
  const fullColor = !environment.widgetRenderingMode || environment.widgetRenderingMode === 'fullColor';
  const amber = environment.colorScheme === 'dark' ? props?.amberDark : props?.amberLight;
  const now = environment.date.getTime();
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const tertiary = { type: 'hierarchical', style: 'tertiary' } as const;

  const stops = props?.stops ?? [];
  const chosen = String(environment.configuration?.stop ?? '').trim();
  const wanted = chosen.toLowerCase();
  const stop = chosen
    ? stops.find(
        (entry) =>
          entry.id === chosen ||
          entry.name.toLowerCase() === wanted ||
          (entry.label ?? '').toLowerCase() === wanted,
      )
    : stops[0];

  if (!stop) {
    // Nothing starred, or the stop this widget was set to has been unstarred.
    const message =
      stops.length === 0
        ? 'Oznacz przystanek gwiazdką w aplikacji, a tu pojawią się jego odjazdy.'
        : 'Tego przystanku nie ma już w ulubionych. Przytrzymaj widżet i wybierz inny.';
    if (lockScreen) {
      return (
        <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(2)]}>
          {stops.length === 0 ? 'Dodaj ulubiony przystanek' : 'Wybierz przystanek'}
        </Text>
      );
    }
    return (
      <VStack alignment="leading" spacing={6}>
        <HStack spacing={5}>
          <Image systemName="star.fill" size={13} color={amber} />
          <Text modifiers={[font({ textStyle: 'headline' })]}>Wroclive</Text>
        </HStack>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(secondary)]}>{message}</Text>
        <Spacer />
      </VStack>
    );
  }

  // The timeline repeats the rows once a minute and each entry counts from its
  // own date, so the widget keeps going with the app closed. A departure the
  // walk cannot reach stays listed — it is on the board at the stop too — but
  // steps back. The last entry is never redrawn, so it trades countdowns
  // (which would freeze) for clock times, which stay true.
  const final = Boolean(props?.final);
  const upcoming = stop.rows.filter((row) => row.at >= now - 30_000);
  const minutesTo = (row: DeparturesWidgetRow) => Math.max(0, Math.round((row.at - now) / 60_000));
  const when = (row: DeparturesWidgetRow) =>
    final ? row.clock : minutesTo(row) < 1 ? 'teraz' : `${minutesTo(row)} min`;
  const reachable = (row: DeparturesWidgetRow) => stop.walk === null || row.at - now >= (stop.walk + 30) * 1_000;
  const countdownStyle = (row: DeparturesWidgetRow) => (reachable(row) ? amber : tertiary);
  const trip = stop.kind === 'trip';
  const title = stop.label || stop.name;
  const subtitle = trip ? (stop.label ? stop.detail : '') : stop.label ? stop.name : stop.detail;
  // A trip's rows are read "leaves in 3 min, there at 7:54": the arrival
  // takes the place a board gives the headsign.
  const arriving = (row: DeparturesWidgetRow) => (row.arriveClock ? `na miejscu ${row.arriveClock}` : row.headsign);
  const rowText = (row: DeparturesWidgetRow) => (trip ? arriving(row) : row.headsign);
  const walkMinutes = stop.walk === null ? null : Math.max(1, Math.round(stop.walk / 60));
  const updated = new Date(props?.updatedAt ?? now);
  const updatedClock = `${String(updated.getHours()).padStart(2, '0')}:${String(updated.getMinutes()).padStart(2, '0')}`;

  const badge = (row: DeparturesWidgetRow, size: number, width: number) => (
    <Text
      modifiers={[
        font({ size, weight: 'bold', design: 'rounded' }),
        monospacedDigit(),
        minimumScaleFactor(0.7),
        lineLimit(1),
        ...(fullColor
          ? [
              foregroundStyle('#FFFFFF'),
              frame({ width, height: size + 7 }),
              background(row.color, shapes.roundedRectangle({ cornerRadius: 6, roundedCornerStyle: 'continuous' })),
            ]
          : [frame({ width, alignment: 'leading' })]),
      ]}>
      {row.line}
    </Text>
  );

  /* --- lock screen ------------------------------------------------------- */

  if (family === 'accessoryInline') {
    const next = upcoming.find(reachable) ?? upcoming[0];
    return (
      <Text modifiers={[widgetURL(stop.url)]}>
        {next
          ? trip
            ? `${next.line} ${final ? next.clock : `za ${when(next)}`} · ${arriving(next)}`
            : `${next.line} ${next.headsign} · ${when(next)}`
          : title}
      </Text>
    );
  }

  if (family === 'accessoryCircular') {
    const next = upcoming.find(reachable) ?? upcoming[0];
    return (
      <ZStack modifiers={[widgetURL(stop.url)]}>
        <AccessoryWidgetBackground />
        <VStack spacing={0}>
          <Text modifiers={[font({ size: 15, weight: 'bold', design: 'rounded' }), minimumScaleFactor(0.6), lineLimit(1)]}>
            {next ? next.line : '—'}
          </Text>
          <Text modifiers={[font({ size: 12, weight: 'semibold' }), monospacedDigit(), minimumScaleFactor(0.6), lineLimit(1)]}>
            {next ? (final ? next.clock : minutesTo(next) < 1 ? 'teraz' : `${minutesTo(next)}'`) : ''}
          </Text>
        </VStack>
      </ZStack>
    );
  }

  if (family === 'accessoryRectangular') {
    return (
      <VStack alignment="leading" spacing={1} modifiers={[widgetURL(stop.url)]}>
        <HStack spacing={3}>
          <Image
            systemName={trip ? 'arrow.triangle.turn.up.right.circle.fill' : upcoming[0]?.tram === false ? 'bus.fill' : 'tram.fill'}
            size={10}
          />
          <Text modifiers={[font({ textStyle: 'caption', weight: 'bold' }), lineLimit(1)]}>{title}</Text>
        </HStack>
        {upcoming.length === 0 ? (
          <Text modifiers={[font({ textStyle: 'caption' })]}>Brak odjazdów</Text>
        ) : (
          upcoming.slice(0, 2).map((row) => (
            <HStack key={`${row.line}-${row.at}`} spacing={4}>
              <Text modifiers={[font({ textStyle: 'caption', weight: 'bold' }), monospacedDigit()]}>{row.line}</Text>
              <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1)]}>
                {trip && row.arriveClock ? `→ ${row.arriveClock}` : row.headsign}
              </Text>
              <Spacer />
              <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), monospacedDigit()]}>{when(row)}</Text>
            </HStack>
          ))
        )}
      </VStack>
    );
  }

  /* --- home screen ------------------------------------------------------- */

  const empty = (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' })]}>
        {trip
          ? 'Brak połączeń w najbliższych godzinach'
          : stop.rows.length === 0
            ? 'Brak danych o odjazdach'
            : 'Brak kolejnych odjazdów'}
      </Text>
      <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(secondary)]}>
        Otwórz aplikację, aby odświeżyć.
      </Text>
    </VStack>
  );

  if (family === 'systemSmall') {
    // Indexing, not `[first, ...rest]`: rest destructuring compiles to a Babel
    // helper (`_toArray`) that the widget extension does not have.
    const first = upcoming[0];
    const rest = upcoming.slice(1);
    return (
      <VStack alignment="leading" spacing={0} modifiers={[widgetURL(stop.url)]}>
        <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle(secondary), lineLimit(1)]}>
          {title}
        </Text>
        {trip && !!stop.label && !!stop.destination && (
          <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(tertiary), lineLimit(1)]}>
            {`→ ${stop.destination}`}
          </Text>
        )}
        <Spacer />
        {!first ? (
          empty
        ) : (
          <VStack alignment="leading" spacing={2}>
            <HStack spacing={5}>
              {badge(first, 13, 30)}
              <Text modifiers={[font({ textStyle: 'caption', weight: 'medium' }), lineLimit(1)]}>{rowText(first)}</Text>
            </HStack>
            {/* The one number a glance is for, given the room it deserves. */}
            <Text
              modifiers={[
                font({ size: 32, weight: 'bold', design: 'rounded' }),
                monospacedDigit(),
                minimumScaleFactor(0.6),
                lineLimit(1),
                foregroundStyle(countdownStyle(first)),
              ]}>
              {when(first)}
            </Text>
          </VStack>
        )}
        <Spacer />
        {rest.length > 0 && (
          <HStack spacing={8}>
            {rest.slice(0, 2).map((row) => (
              <HStack key={`${row.line}-${row.at}`} spacing={3}>
                {badge(row, 11, 24)}
                <Text
                  modifiers={[
                    font({ textStyle: 'caption', weight: 'semibold' }),
                    monospacedDigit(),
                    lineLimit(1),
                    foregroundStyle(countdownStyle(row)),
                  ]}>
                  {when(row)}
                </Text>
              </HStack>
            ))}
          </HStack>
        )}
      </VStack>
    );
  }

  const large = family === 'systemLarge' || family === 'systemExtraLarge';
  const shown = upcoming.slice(0, large ? 8 : 4);

  return (
    <VStack alignment="leading" spacing={large ? 8 : 5} modifiers={[widgetURL(stop.url)]}>
      <HStack spacing={6}>
        <VStack alignment="leading" spacing={0}>
          <Text modifiers={[font({ textStyle: large ? 'headline' : 'subheadline', weight: 'bold' }), lineLimit(1)]}>
            {title}
          </Text>
          {(large || !!stop.label) && !!subtitle && (
            <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(secondary), lineLimit(1)]}>{subtitle}</Text>
          )}
        </VStack>
        <Spacer />
        {walkMinutes !== null && (
          <HStack spacing={2}>
            <Image systemName="figure.walk" size={11} />
            <Text modifiers={[font({ textStyle: 'caption', weight: 'medium' }), monospacedDigit()]}>{`${walkMinutes} min`}</Text>
          </HStack>
        )}
      </HStack>
      {shown.length === 0
        ? empty
        : shown.map((row) => (
            <HStack key={`${row.line}-${row.at}`} spacing={8}>
              {badge(row, large ? 14 : 13, large ? 36 : 32)}
              {large ? (
                <VStack alignment="leading" spacing={0}>
                  <Text modifiers={[font({ textStyle: 'subheadline', weight: 'medium' }), lineLimit(1)]}>{rowText(row)}</Text>
                  <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(secondary), monospacedDigit(), lineLimit(1)]}>
                    {trip
                      ? `odjazd ${row.clock} · ${row.headsign}`
                      : row.live
                        ? `${row.clock} · na żywo`
                        : `${row.clock} · rozkład`}
                  </Text>
                </VStack>
              ) : (
                <Text modifiers={[font({ textStyle: 'subheadline' }), lineLimit(1)]}>{rowText(row)}</Text>
              )}
              <Spacer />
              <Text
                modifiers={[
                  font({ textStyle: large ? 'headline' : 'subheadline', weight: 'semibold' }),
                  monospacedDigit(),
                  foregroundStyle(countdownStyle(row)),
                ]}>
                {when(row)}
              </Text>
            </HStack>
          ))}
      <Spacer />
      {(large || final) && (
        <Text modifiers={[font({ textStyle: 'caption2' }), foregroundStyle(tertiary)]}>
          {final ? `Stan z ${updatedClock} · otwórz, aby odświeżyć` : `Aktualizacja ${updatedClock}`}
        </Text>
      )}
    </VStack>
  );
};

const ArrivalActivity = (props: ArrivalActivityProps, environment: LiveActivityEnvironment) => {
  'widget';
  const amber = environment.colorScheme === 'dark' ? props.amberDark : props.amberLight;
  const stale = Boolean(environment.isStale);
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const badge = (
    <Text
      modifiers={[
        font({ size: 15, weight: 'bold', design: 'rounded' }),
        foregroundStyle('#FFFFFF'),
        padding({ horizontal: 7, vertical: 2 }),
        background(props.color, shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: 'continuous' })),
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
        font({ textStyle: 'headline', design: 'rounded' }),
        monospacedDigit(),
        foregroundStyle(stale ? secondary : amber),
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
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(secondary), lineLimit(1)]}>{subtitle}</Text>
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
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(secondary), lineLimit(1)]}>{subtitle}</Text>
    ),
  };
};

/**
 * "Jadę do…": the rider is on board, and the number that matters is how many
 * stops are left — a tram's own display counts in stops, and so does anyone
 * riding it. The clock is still there, smaller: it is the estimate, the count
 * is the fact.
 */
const TripActivity = (props: TripActivityProps, environment: LiveActivityEnvironment) => {
  'widget';
  const amber = environment.colorScheme === 'dark' ? props.amberDark : props.amberLight;
  const stale = Boolean(environment.isStale);
  const secondary = { type: 'hierarchical', style: 'secondary' } as const;
  const away = Math.max(0, Math.round(props.stopsAway ?? 0));
  const total = Math.max(1, Math.round(props.totalStops ?? 1), away);
  const arrived = props.atStop || away === 0;
  const done = arrived ? 1 : Math.min(1, Math.max(0, (total - away) / total));
  const stopsWord = (count: number) => {
    if (count === 1) return 'przystanek';
    const units = count % 10;
    const tens = count % 100;
    return units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14) ? 'przystanki' : 'przystanków';
  };
  const headline = arrived ? 'Wysiadasz tutaj' : away === 1 ? 'Wysiadasz na następnym' : `Jeszcze ${away} ${stopsWord(away)}`;

  const badge = (size: number) => (
    <Text
      modifiers={[
        font({ size, weight: 'bold', design: 'rounded' }),
        foregroundStyle('#FFFFFF'),
        padding({ horizontal: 7, vertical: 2 }),
        background(props.color, shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: 'continuous' })),
      ]}>
      {props.line}
    </Text>
  );
  const count = arrived ? (
    <Image systemName="figure.walk.departure" size={26} color={amber} />
  ) : (
    <Text
      modifiers={[
        font({ size: 30, weight: 'bold', design: 'rounded' }),
        monospacedDigit(),
        foregroundStyle(stale ? secondary : amber),
      ]}>
      {String(away)}
    </Text>
  );
  const timer = arrived ? (
    <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle(amber)]}>teraz</Text>
  ) : (
    <Text
      timerInterval={{ lower: new Date(props.since), upper: new Date(props.arrivesAt) }}
      countsDown
      modifiers={[
        font({ textStyle: 'caption', weight: 'semibold', design: 'rounded' }),
        monospacedDigit(),
        foregroundStyle(secondary),
        frame({ maxWidth: 56, alignment: 'trailing' }),
      ]}
    />
  );
  const progress = <ProgressView value={done} modifiers={[tint(props.color)]} />;
  const following = arrived ? `Przystanek ${props.stopName}` : `Następny: ${props.nextStop || props.stopName}`;

  return {
    banner: (
      <VStack spacing={9} modifiers={[padding({ all: 14 })]}>
        <HStack spacing={10}>
          {badge(15)}
          <VStack alignment="leading" spacing={1}>
            <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1)]}>{headline}</Text>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(secondary), lineLimit(1)]}>
              {`Wysiadka: ${props.stopName}`}
            </Text>
          </VStack>
          <Spacer />
          {count}
        </HStack>
        {progress}
        <HStack spacing={6}>
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(secondary), lineLimit(1)]}>{following}</Text>
          <Spacer />
          {timer}
        </HStack>
      </VStack>
    ),
    compactLeading: badge(13),
    compactTrailing: arrived ? (
      <Image systemName="figure.walk.departure" size={15} color={amber} />
    ) : (
      <Text modifiers={[font({ size: 15, weight: 'bold', design: 'rounded' }), monospacedDigit(), foregroundStyle(amber)]}>
        {`${away} przyst.`}
      </Text>
    ),
    minimal: (
      <Text modifiers={[font({ size: 14, weight: 'bold', design: 'rounded' }), foregroundStyle(amber)]}>
        {arrived ? '✓' : String(away)}
      </Text>
    ),
    expandedLeading: badge(15),
    expandedTrailing: count,
    expandedCenter: (
      <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1)]}>{headline}</Text>
    ),
    expandedBottom: (
      <VStack spacing={6}>
        {progress}
        <HStack spacing={6}>
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(secondary), lineLimit(1)]}>
            {arrived ? following : `${following} · wysiadka: ${props.stopName}`}
          </Text>
          <Spacer />
          {timer}
        </HStack>
      </VStack>
    ),
  };
};

export const departuresWidget = createWidget<DeparturesWidgetProps, DeparturesWidgetConfiguration>(
  'Departures',
  DeparturesWidget,
);
export const arrivalActivity = createLiveActivity<ArrivalActivityProps>('Arrival', ArrivalActivity);
export const tripActivity = createLiveActivity<TripActivityProps>('Trip', TripActivity);
