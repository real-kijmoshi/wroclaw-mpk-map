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
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  kerning,
  minimumScaleFactor,
  monospacedDigit,
  opacity,
  padding,
  shapes,
  textCase,
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
  /**
   * `at` as the rider's wall clock, "22:41". No longer written — the layout
   * formats `at` itself, which saves a day-long timeline a string per row —
   * but present on timelines written before that.
   */
  clock?: string;
  /** A live prediction rather than the timetable. */
  live: boolean;
  /** Saved trips only: when this departure reaches the destination. */
  arriveAt?: number | null;
  /** `arriveAt` as a clock; no longer written, see `clock`. */
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
  /**
   * "08:54": the last departure the app handed over, so the widget can say how
   * far its timetable reaches. Missing on timelines written before it existed.
   */
  until?: string | null;
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
  /**
   * First entry only: what the widget extension fetches itself between the
   * app's writes — the API and each stop's (or trip's) platforms.
   */
  fetch?: { api: string; sources: Record<string, { ids: string[]; to?: string[] }> };
  /** Past the first half hour no entry redraws this one a minute later, so it shows clock times, not countdowns. */
  final: boolean;
  /**
   * The timeline's last entry. Nothing replaces it, so it carries no rows and
   * only asks for the app to be opened: a departure listed here would still
   * be listed hours after it left. Missing on timelines written before it existed.
   */
  expired?: boolean;
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
  // Clock times are formatted here, not stored per row: a day of entries
  // repeats every row many times over.
  const hhmm = (at: number) => {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  };
  const clockOf = (row: DeparturesWidgetRow) => row.clock || hhmm(row.at);
  const arriveClockOf = (row: DeparturesWidgetRow) =>
    row.arriveClock || (row.arriveAt != null ? hhmm(row.arriveAt) : null);
  const final = Boolean(props?.final);
  const expired = Boolean(props?.expired);
  const upcoming = stop.rows.filter((row) => row.at >= now - 30_000);
  const minutesTo = (row: DeparturesWidgetRow) => Math.max(0, Math.round((row.at - now) / 60_000));
  const when = (row: DeparturesWidgetRow) =>
    final ? clockOf(row) : minutesTo(row) < 1 ? 'teraz' : `${minutesTo(row)} min`;
  const reachable = (row: DeparturesWidgetRow) => stop.walk == null || row.at - now >= (stop.walk + 30) * 1_000;
  const trip = stop.kind === 'trip';
  const title = stop.label || stop.name;
  const subtitle = trip ? (stop.label ? stop.detail : '') : stop.label ? stop.name : stop.detail;
  // A trip's rows are read "leaves in 3 min, there at 7:54": the arrival
  // takes the place a board gives the headsign.
  const arriving = (row: DeparturesWidgetRow) => (arriveClockOf(row) ? `na miejscu ${arriveClockOf(row)}` : row.headsign);
  const rowText = (row: DeparturesWidgetRow) => (trip ? arriving(row) : row.headsign);
  const walkMinutes = stop.walk == null ? null : Math.max(1, Math.round(stop.walk / 60));
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
            ? `${next.line} ${final ? clockOf(next) : `za ${when(next)}`} · ${arriving(next)}`
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
            {next ? (final ? clockOf(next) : minutesTo(next) < 1 ? 'teraz' : `${minutesTo(next)}'`) : ''}
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
          <Text modifiers={[font({ textStyle: 'caption' })]}>{expired ? 'Otwórz, aby odświeżyć' : 'Brak odjazdów'}</Text>
        ) : (
          upcoming.slice(0, 2).map((row) => (
            <HStack key={`${row.line}-${row.at}`} spacing={4}>
              <Text modifiers={[font({ textStyle: 'caption', weight: 'bold' }), monospacedDigit()]}>{row.line}</Text>
              <Text modifiers={[font({ textStyle: 'caption' }), lineLimit(1)]}>
                {trip && arriveClockOf(row) ? `→ ${arriveClockOf(row)}` : row.headsign}
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

  // The home-screen widget is a stop's departure board, the one on the
  // landing page: a dark board in either scheme (a real one at the stop does
  // not turn white at noon), destinations in capitals, amber countdowns, and a
  // departure the walk cannot reach stepped back. Tinted and clear home
  // screens recolour everything, so there it keeps the system's background
  // and hierarchical styles instead.
  const ink = fullColor ? '#EAF1F7' : { type: 'hierarchical', style: 'primary' } as const;
  const dim = fullColor ? '#8FA1B1' : secondary;
  const faint = fullColor ? '#5F7181' : tertiary;
  const live = '#3DDC84';
  const boardAmber = fullColor ? props?.amberDark ?? amber : amber;
  const countdownColor = (row: DeparturesWidgetRow) => (reachable(row) ? boardAmber : faint);
  const board = fullColor
    ? [
        containerBackground(
          {
            type: 'linearGradient',
            colors: ['#13222F', '#0A141C'],
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 0.4, y: 1 },
          },
          'widget',
        ),
      ]
    : [];
  const anyLive = !final && upcoming.some((row) => row.live);
  const ageMinutes = Math.max(0, Math.round((now - updated.getTime()) / 60_000));
  const until = stop.until ?? (upcoming.length ? clockOf(upcoming[upcoming.length - 1]) : null);

  // How fresh this is, said plainly: the clock it was fetched at, and either
  // that it is live or how far the timetable it is reading from reaches.
  const status = (compact: boolean) => (
    <HStack spacing={4}>
      <Image systemName="arrow.clockwise" size={9} color={fullColor ? '#5F7181' : undefined} />
      <Text modifiers={[font({ size: 11, weight: 'medium' }), monospacedDigit(), foregroundStyle(faint), lineLimit(1)]}>
        {compact ? updatedClock : ageMinutes < 1 ? `Odświeżono ${updatedClock}` : `Odświeżono ${updatedClock} · ${ageMinutes < 60 ? `${ageMinutes} min temu` : `${Math.floor(ageMinutes / 60)} godz. temu`}`}
      </Text>
      <Spacer />
      {anyLive ? (
        <HStack spacing={3}>
          <Text modifiers={[font({ size: 8 }), foregroundStyle(fullColor ? live : secondary)]}>●</Text>
          <Text modifiers={[font({ size: 11, weight: 'semibold' }), foregroundStyle(fullColor ? live : secondary)]}>na żywo</Text>
        </HStack>
      ) : until && !compact ? (
        <Text modifiers={[font({ size: 11, weight: 'medium' }), monospacedDigit(), foregroundStyle(faint), lineLimit(1)]}>
          {`rozkład do ${until}`}
        </Text>
      ) : null}
    </HStack>
  );

  const headsignText = (row: DeparturesWidgetRow, size: number) => (
    <Text
      modifiers={[
        font({ size, weight: 'semibold' }),
        ...(trip ? [] : [textCase('uppercase'), kerning(0.2)]),
        foregroundStyle(ink),
        lineLimit(1),
        minimumScaleFactor(0.75),
      ]}>
      {rowText(row)}
    </Text>
  );

  // The last entry: nothing will replace it, so it shows no departures, only
  // when the board was fetched and what to do. A tap opens the app, which is
  // the refresh.
  const stale = (
    <VStack alignment="leading" spacing={4}>
      <HStack spacing={6}>
        <Image systemName="arrow.clockwise.circle.fill" size={20} color={boardAmber} />
        <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle(ink), lineLimit(1), minimumScaleFactor(0.8)]}>
          Dotknij, aby odświeżyć
        </Text>
      </HStack>
      <Text modifiers={[font({ size: 12 }), foregroundStyle(dim), lineLimit(2)]}>
        {`Odjazdy z ${updatedClock} już minęły. Otwarcie aplikacji pobierze nowe.`}
      </Text>
    </VStack>
  );

  const empty = expired ? (
    stale
  ) : (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(ink)]}>
        {trip
          ? 'Brak połączeń w najbliższych godzinach'
          : stop.rows.length === 0
            ? 'Brak danych o odjazdach'
            : 'Brak kolejnych odjazdów'}
      </Text>
      <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>Otwórz aplikację, aby odświeżyć.</Text>
    </VStack>
  );

  const walkChip =
    walkMinutes !== null ? (
      <HStack spacing={2}>
        <Image systemName="figure.walk" size={11} color={fullColor ? '#EAF1F7' : undefined} />
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), monospacedDigit(), foregroundStyle(ink)]}>
          {`${walkMinutes} min`}
        </Text>
      </HStack>
    ) : null;

  if (family === 'systemSmall') {
    // Indexing, not `[first, ...rest]`: rest destructuring compiles to a Babel
    // helper (`_toArray`) that the widget extension does not have.
    const first = upcoming[0];
    const rest = upcoming.slice(1);
    return (
      <VStack alignment="leading" spacing={0} modifiers={[widgetURL(stop.url), ...board]}>
        <HStack spacing={4}>
          <Text modifiers={[font({ size: 13, weight: 'bold' }), foregroundStyle(ink), lineLimit(1)]}>{title}</Text>
          <Spacer />
          {walkChip}
        </HStack>
        {!!subtitle && (
          <Text
            modifiers={[font({ size: 10, weight: 'medium' }), textCase('uppercase'), foregroundStyle(dim), lineLimit(1)]}>
            {trip && stop.destination ? `→ ${stop.destination}` : subtitle}
          </Text>
        )}
        <Spacer />
        {!first || expired ? (
          empty
        ) : (
          <VStack alignment="leading" spacing={1}>
            <HStack spacing={5}>
              {badge(first, 13, 30)}
              {headsignText(first, 12)}
            </HStack>
            {/* The one number a glance is for, given the room it deserves. */}
            <Text
              modifiers={[
                font({ size: 34, weight: 'bold', design: 'rounded' }),
                monospacedDigit(),
                minimumScaleFactor(0.6),
                lineLimit(1),
                foregroundStyle(countdownColor(first)),
              ]}>
              {when(first)}
            </Text>
          </VStack>
        )}
        <Spacer />
        {!expired && rest.length > 0 ? (
          <HStack spacing={8}>
            {rest.slice(0, 2).map((row) => (
              <HStack key={`${row.line}-${row.at}`} spacing={3} modifiers={reachable(row) ? [] : [opacity(0.55)]}>
                {badge(row, 11, 24)}
                <Text
                  modifiers={[
                    font({ size: 12, weight: 'semibold' }),
                    monospacedDigit(),
                    lineLimit(1),
                    foregroundStyle(countdownColor(row)),
                  ]}>
                  {when(row)}
                </Text>
              </HStack>
            ))}
          </HStack>
        ) : (
          status(true)
        )}
      </VStack>
    );
  }

  const large = family === 'systemLarge' || family === 'systemExtraLarge';
  const shown = upcoming.slice(0, large ? 7 : 3);

  return (
    <VStack alignment="leading" spacing={large ? 7 : 4} modifiers={[widgetURL(stop.url), ...board]}>
      <HStack spacing={6}>
        <Text modifiers={[font({ size: large ? 17 : 15, weight: 'bold' }), foregroundStyle(ink), lineLimit(1)]}>
          {title}
        </Text>
        {!!subtitle && (
          <Text
            modifiers={[
              font({ size: 11, weight: 'medium' }),
              textCase('uppercase'),
              kerning(0.3),
              foregroundStyle(dim),
              lineLimit(1),
            ]}>
            {subtitle}
          </Text>
        )}
        <Spacer />
        {walkChip}
      </HStack>
      {shown.length === 0 || expired ? (
        <VStack alignment="leading" spacing={0}>
          <Spacer />
          {empty}
          <Spacer />
        </VStack>
      ) : (
        <VStack alignment="leading" spacing={large ? 9 : 5}>
          {shown.map((row) => (
            <HStack key={`${row.line}-${row.at}`} spacing={8} modifiers={reachable(row) ? [] : [opacity(0.55)]}>
              {badge(row, large ? 14 : 13, large ? 36 : 32)}
              {large ? (
                <VStack alignment="leading" spacing={0}>
                  {headsignText(row, 14)}
                  <Text modifiers={[font({ size: 11 }), foregroundStyle(dim), monospacedDigit(), lineLimit(1)]}>
                    {trip ? `odjazd ${clockOf(row)} · ${row.headsign}` : row.live && !final ? `${clockOf(row)} · na żywo` : `${clockOf(row)} · rozkład`}
                  </Text>
                </VStack>
              ) : (
                headsignText(row, 13)
              )}
              <Spacer />
              {row.live && !final && fullColor && (
                <Text modifiers={[font({ size: 7 }), foregroundStyle(live)]}>●</Text>
              )}
              <Text
                modifiers={[
                  font({ size: large ? 17 : 15, weight: 'bold', design: 'rounded' }),
                  monospacedDigit(),
                  lineLimit(1),
                  foregroundStyle(countdownColor(row)),
                ]}>
                {when(row)}
              </Text>
            </HStack>
          ))}
        </VStack>
      )}
      <Spacer />
      {status(false)}
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
  // Stale means nothing has refreshed the count since the next stop was due:
  // it is one too many at best, so it is not drawn. What is left is true on
  // its own — where to get off, and the native countdown to it.
  const unsure = stale && !arrived;
  const arrival = new Date(props.arrivesAt);
  const arrivalClock = `${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')}`;
  const done = arrived ? 1 : Math.min(1, Math.max(0, (total - away) / total));
  const stopsWord = (count: number) => {
    if (count === 1) return 'przystanek';
    const units = count % 10;
    const tens = count % 100;
    return units >= 2 && units <= 4 && !(tens >= 12 && tens <= 14) ? 'przystanki' : 'przystanków';
  };
  const headline = arrived
    ? 'Wysiadasz tutaj'
    : unsure
      ? `Na miejscu ok. ${arrivalClock}`
      : away === 1
        ? 'Wysiadasz na następnym'
        : `Jeszcze ${away} ${stopsWord(away)}`;

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
  ) : unsure ? (
    <Text
      timerInterval={{ lower: new Date(props.since), upper: new Date(props.arrivesAt) }}
      countsDown
      modifiers={[
        font({ size: 24, weight: 'bold', design: 'rounded' }),
        monospacedDigit(),
        foregroundStyle(amber),
        frame({ maxWidth: 84, alignment: 'trailing' }),
      ]}
    />
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
  const following = arrived
    ? `Przystanek ${props.stopName}`
    : unsure
      ? 'Otwórz aplikację, by policzyć przystanki'
      : `Następny: ${props.nextStop || props.stopName}`;

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
          {unsure ? null : timer}
        </HStack>
      </VStack>
    ),
    compactLeading: badge(13),
    compactTrailing: arrived ? (
      <Image systemName="figure.walk.departure" size={15} color={amber} />
    ) : unsure ? (
      <Text
        timerInterval={{ lower: new Date(props.since), upper: new Date(props.arrivesAt) }}
        countsDown
        modifiers={[
          font({ size: 15, weight: 'bold', design: 'rounded' }),
          monospacedDigit(),
          foregroundStyle(amber),
          frame({ maxWidth: 52, alignment: 'trailing' }),
        ]}
      />
    ) : (
      <Text modifiers={[font({ size: 15, weight: 'bold', design: 'rounded' }), monospacedDigit(), foregroundStyle(amber)]}>
        {`${away} przyst.`}
      </Text>
    ),
    minimal: (
      <Text modifiers={[font({ size: 14, weight: 'bold', design: 'rounded' }), foregroundStyle(amber)]}>
        {arrived ? '✓' : unsure ? props.line : String(away)}
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
            {arrived || unsure ? following : `${following} · wysiadka: ${props.stopName}`}
          </Text>
          <Spacer />
          {unsure ? null : timer}
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
