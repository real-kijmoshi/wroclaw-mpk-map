import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Divider, Section } from '@/components/list';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space, Type, Weight } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { getPlan, type Plan, type PlanRideLeg, type Stop } from '@/lib/api';
import { favouritesStore } from '@/lib/favourites';
import { plural } from '@/lib/format';
import { tapped } from '@/lib/haptics';
import { mapIntentStore } from '@/lib/map-intent';
import { searchStops } from '@/lib/stops-api';

/**
 * "How do I get there" — the question this app could not answer.
 *
 * The map tells a rider where the trams are, which is only useful once they
 * already know which tram. This screen is the other half, and it is the reason
 * people keep a second transit app installed.
 *
 * Both ends are either the rider's own position or a stop, and the server
 * resolves `stop:<id>` itself, so nothing here has to look a stop's
 * coordinates up before it can ask.
 */

type Endpoint =
  | { kind: 'me' }
  | { kind: 'stop'; stop: Stop };

/**
 * Departure times offered without a date picker.
 *
 * A wheel picker would need a dependency and a modal for a decision that is,
 * in practice, one of four: now, or shortly. Planning further ahead than an
 * hour is a timetable question, and the stop board answers that with `?at=`.
 */
const WHEN_OPTIONS: { label: string; minutes: number }[] = [
  { label: 'Teraz', minutes: 0 },
  { label: 'za 15 min', minutes: 15 },
  { label: 'za 30 min', minutes: 30 },
  { label: 'za godzinę', minutes: 60 },
];

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

const durationLabel = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

const walkLabel = (meters: number) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;

export default function PlanScreen() {
  const theme = useTheme();
  const router = useRouter();

  const [from, setFrom] = useState<Endpoint>({ kind: 'me' });
  const [to, setTo] = useState<Endpoint | null>(null);
  const [editing, setEditing] = useState<'from' | 'to' | null>('to');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Stop[]>([]);
  const [whenMinutes, setWhenMinutes] = useState(0);

  const [position, setPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [positionDenied, setPositionDenied] = useState(false);

  /**
   * The last answer, tagged with the question it answers.
   *
   * One piece of state rather than four, and every write to it happens after
   * an await — which is what lets "is a plan in flight" be *derived* (the
   * answer on hand is for an older question) instead of being a flag an
   * effect has to set synchronously and then remember to clear on every exit
   * path, including the ones that throw.
   */
  const [answer, setAnswer] = useState<
    | { key: string; plans: Plan[]; walkOnly: Plan | null; failure?: undefined }
    | { key: string; failure: string; plans?: undefined; walkOnly?: undefined }
    | null
  >(null);

  /*
   * The rider's position, fetched once and only if an endpoint needs it.
   *
   * Asking at mount would prompt for location on a screen that may never use
   * it — planning between two named stops needs no position at all.
   */
  const needsPosition = from.kind === 'me' || to?.kind === 'me';
  useEffect(() => {
    if (!needsPosition || position || positionDenied) return;
    let cancelled = false;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          if (!cancelled) setPositionDenied(true);
          return;
        }
        const fix = await Location.getLastKnownPositionAsync()
          ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        if (cancelled || !fix) return;
        setPosition({ lat: fix.coords.latitude, lon: fix.coords.longitude });
      } catch {
        if (!cancelled) setPositionDenied(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [needsPosition, position, positionDenied]);

  /* --- stop search ---------------------------------------------------------- */

  const needle = query.trim();
  // Whether results are *shown* is derived from the query, not stored: the
  // effect below only ever fills the list, so a cleared field cannot leave
  // yesterday's matches on screen while the next request is in flight.
  const searching = Boolean(editing) && needle.length >= 2;
  const visibleResults = searching ? results : [];

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchStops(needle, { signal: controller.signal })
        .then((stops) => setResults(stops.slice(0, 12)))
        .catch(() => setResults([]));
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [needle, searching]);

  /* --- planning ------------------------------------------------------------- */

  const describe = useCallback(
    (endpoint: Endpoint | null): string | null => {
      if (!endpoint) return null;
      if (endpoint.kind === 'stop') return `stop:${endpoint.stop.id}`;
      if (!position) return null;
      return `${position.lat},${position.lon}`;
    },
    [position],
  );

  const fromParam = describe(from);
  const toParam = describe(to);

  // The question, as one string. Everything the plan depends on is in it, so
  // an answer tagged with a different key is by definition out of date.
  const question = fromParam && toParam ? `${fromParam}|${toParam}|${whenMinutes}` : null;

  useEffect(() => {
    if (!question || !fromParam || !toParam) return;
    const controller = new AbortController();

    getPlan(fromParam, toParam, {
      signal: controller.signal,
      at: whenMinutes ? new Date(Date.now() + whenMinutes * 60_000) : undefined,
      fromName: from.kind === 'me' ? 'Moja lokalizacja' : undefined,
      toName: to?.kind === 'me' ? 'Moja lokalizacja' : undefined,
    })
      .then((journey) => {
        setAnswer({ key: question, plans: journey.plans, walkOnly: journey.walkOnly });
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setAnswer({ key: question, failure: 'Nie udało się wyznaczyć trasy' });
      });

    return () => controller.abort();
  }, [question, fromParam, toParam, whenMinutes, from.kind, to?.kind]);

  const pick = (stop: Stop) => {
    if (editing === 'from') setFrom({ kind: 'stop', stop });
    else setTo({ kind: 'stop', stop });
    tapped();
    setQuery('');
    setResults([]);
    // Straight on to the other field while it is still unset: a rider who has
    // just named where they are going is about to say where from. Both named,
    // and the search closes so the results have the screen.
    setEditing(editing === 'from' ? (to ? null : 'to') : null);
  };

  const label = (endpoint: Endpoint | null, fallback: string) => {
    if (!endpoint) return fallback;
    if (endpoint.kind === 'me') return 'Moja lokalizacja';
    return endpoint.stop.name;
  };

  const swap = () => {
    if (!to) return;
    setFrom(to);
    setTo(from);
    tapped();
  };

  const ready = Boolean(question);
  // An answer to a different question is not an answer. Showing the previous
  // pair's plans while the new pair is in flight is how an app tells someone
  // to catch a tram from a stop they are no longer asking about.
  const current = answer?.key === question ? answer : null;
  const planning = ready && !current;
  const visiblePlans = current?.plans ?? null;
  const visibleWalkOnly = current?.walkOnly ?? null;
  const failure = current?.failure ?? null;

  const subtitle = useMemo(() => {
    if (needsPosition && positionDenied) return 'Brak dostępu do lokalizacji';
    if (needsPosition && !position) return 'Ustalanie pozycji…';
    if (!ready) return 'Wybierz początek i cel';
    return null;
  }, [needsPosition, position, positionDenied, ready]);

  return (
    <ModalScreen title="Dojazd" subtitle={subtitle ?? undefined}>
      <View style={styles.content}>
        <Section>
          <EndpointRow
            icon="radio-button-on"
            placeholder="Skąd"
            value={label(from, 'Skąd')}
            active={editing === 'from'}
            onPress={() => setEditing(editing === 'from' ? null : 'from')}
            onUseLocation={() => {
              setFrom({ kind: 'me' });
              setEditing(null);
            }}
          />
          <Divider />
          <EndpointRow
            icon="location"
            placeholder="Dokąd"
            value={label(to, 'Dokąd')}
            active={editing === 'to'}
            onPress={() => setEditing(editing === 'to' ? null : 'to')}
            onUseLocation={() => {
              setTo({ kind: 'me' });
              setEditing(null);
            }}
          />
        </Section>

        {!!to && (
          <Pressable
            onPress={swap}
            accessibilityRole="button"
            accessibilityLabel="Zamień początek i cel"
            style={({ pressed }) => [styles.swap, pressed && styles.pressed]}>
            <Ionicons name="swap-vertical" size={16} color={theme.accent} />
            <ThemedText type="footnote" weight="semibold" color={theme.accent}>
              Zamień
            </ThemedText>
          </Pressable>
        )}

        {editing && (
          <View
            style={[
              styles.search,
              { backgroundColor: theme.backgroundElement, borderColor: theme.separator },
            ]}>
            <Ionicons name="search" size={18} color={theme.textSecondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={editing === 'from' ? 'Przystanek początkowy' : 'Przystanek docelowy'}
              placeholderTextColor={theme.textSecondary}
              style={[styles.input, { color: theme.text }]}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              inputMode="search"
              returnKeyType="search"
            />
          </View>
        )}

        {visibleResults.length > 0 && (
          <Section>
            {visibleResults.map((stop, index) => (
              <View key={stop.id}>
                {index > 0 && <Divider />}
                <Pressable
                  onPress={() => pick(stop)}
                  accessibilityRole="button"
                  accessibilityLabel={stop.name}
                  style={({ pressed }) => [styles.result, pressed && styles.pressed]}>
                  <Ionicons name="ellipse-outline" size={15} color={theme.textTertiary} />
                  <View style={styles.resultText}>
                    <ThemedText type="body" numberOfLines={1}>
                      {stop.name}
                    </ThemedText>
                    {!!stop.lines?.length && (
                      <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
                        {stop.lines.join(' · ')}
                      </ThemedText>
                    )}
                  </View>
                </Pressable>
              </View>
            ))}
          </Section>
        )}

        {ready && (
          <View style={styles.when}>
            {WHEN_OPTIONS.map((option) => {
              const active = option.minutes === whenMinutes;
              return (
                <Pressable
                  key={option.minutes}
                  onPress={() => {
                    setWhenMinutes(option.minutes);
                    tapped();
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      backgroundColor: active ? theme.accent : theme.backgroundElement,
                      borderColor: active ? theme.accent : theme.separator,
                    },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText
                    type="footnote"
                    weight="semibold"
                    color={active ? '#ffffff' : theme.textSecondary}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        )}

        {planning && (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        )}

        {!!failure && !planning && (
          <View style={styles.centered}>
            <ThemedText themeColor="textSecondary">{failure}</ThemedText>
          </View>
        )}

        {!planning && visibleWalkOnly && (
          <Section title="Na piechotę">
            <View style={styles.walkOnly}>
              <Ionicons name="walk" size={18} color={theme.textSecondary} />
              <ThemedText type="callout">
                {walkLabel(visibleWalkOnly.walkMeters)} · {durationLabel(visibleWalkOnly.durationSeconds)}
              </ThemedText>
            </View>
          </Section>
        )}

        {!planning && visiblePlans !== null && visiblePlans.length === 0 && !visibleWalkOnly && (
          <View style={styles.centered}>
            <ThemedText themeColor="textSecondary">Brak połączeń o tej porze</ThemedText>
          </View>
        )}

        {!planning &&
          visiblePlans?.map((plan, index) => (
            <PlanCard
              key={`${plan.departure}-${plan.transfers}-${index}`}
              plan={plan}
              onOpenStop={(stop) => {
                mapIntentStore.openStop(stop);
                router.dismissTo('/');
              }}
            />
          ))}
      </View>
    </ModalScreen>
  );
}

function EndpointRow({
  icon,
  placeholder,
  value,
  active,
  onPress,
  onUseLocation,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  placeholder: string;
  value: string;
  active: boolean;
  onPress: () => void;
  onUseLocation: () => void;
}) {
  const theme = useTheme();
  const empty = value === placeholder;

  return (
    <View style={styles.endpoint}>
      <Ionicons name={icon} size={16} color={active ? theme.accent : theme.textTertiary} />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${placeholder}: ${empty ? 'nie wybrano' : value}`}
        style={({ pressed }) => [styles.endpointLabel, pressed && styles.pressed]}>
        <ThemedText
          type="body"
          themeColor={empty ? 'textTertiary' : 'text'}
          numberOfLines={1}>
          {value}
        </ThemedText>
      </Pressable>
      <Pressable
        onPress={onUseLocation}
        accessibilityRole="button"
        accessibilityLabel={`Użyj mojej lokalizacji jako: ${placeholder}`}
        hitSlop={8}
        style={({ pressed }) => [pressed && styles.pressed]}>
        <Ionicons name="locate" size={17} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

/**
 * One way of getting there.
 *
 * The header is what a rider compares on — leave, arrive, how long, how many
 * changes — and the legs below are the instructions once they have chosen.
 * The server returns a Pareto front, so two cards never differ only by being
 * worse: a later one always arrives sooner or changes less.
 */
function PlanCard({ plan, onOpenStop }: { plan: Plan; onOpenStop: (stop: Stop) => void }) {
  const theme = useTheme();
  const rides = plan.legs.filter((leg): leg is PlanRideLeg => leg.mode === 'ride');

  return (
    <Section>
      <View style={styles.planHeader}>
        <View style={styles.planTimes}>
          <ThemedText type="title" style={styles.planClock}>
            {clock(plan.departure)}
          </ThemedText>
          <Ionicons name="arrow-forward" size={14} color={theme.textTertiary} />
          <ThemedText type="title" style={styles.planClock}>
            {clock(plan.arrival)}
          </ThemedText>
        </View>
        <View style={styles.planMeta}>
          <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
            {durationLabel(plan.durationSeconds)}
          </ThemedText>
          <ThemedText type="footnote" themeColor="textTertiary">
            {plan.transfers === 0
              ? 'bez przesiadek'
              : `${plan.transfers} ${plural(plan.transfers, ['przesiadka', 'przesiadki', 'przesiadek'])}`}
          </ThemedText>
        </View>
      </View>

      {/* The route at a glance: the badges are what a rider recognises. */}
      <View style={styles.planSummary}>
        {rides.map((ride, index) => (
          <View key={`${ride.tripId}-${index}`} style={styles.planSummaryItem}>
            {index > 0 && <Ionicons name="chevron-forward" size={12} color={theme.textTertiary} />}
            <LineBadge line={ride.line} type={ride.type} size="xs" />
          </View>
        ))}
        {plan.walkMeters > 0 && (
          <View style={styles.planSummaryItem}>
            <Ionicons name="walk" size={13} color={theme.textTertiary} />
            <ThemedText type="caption" themeColor="textTertiary">
              {walkLabel(plan.walkMeters)}
            </ThemedText>
          </View>
        )}
      </View>

      <Divider />

      {plan.legs.map((leg, index) => (
        <View key={index} style={styles.leg}>
          {leg.mode === 'walk' ? (
            <>
              <Ionicons name="walk" size={17} color={theme.textTertiary} style={styles.legIcon} />
              <View style={styles.legText}>
                <ThemedText type="callout" numberOfLines={2}>
                  Przejdź {walkLabel(leg.meters)} do {leg.to.name ?? 'celu'}
                </ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary">
                  ok. {Math.max(1, Math.round(leg.seconds / 60))} min
                </ThemedText>
              </View>
            </>
          ) : (
            <>
              <LineBadge line={leg.line} type={leg.type} size="small" style={styles.legIcon} />
              <View style={styles.legText}>
                <Pressable
                  onPress={() =>
                    leg.from.id
                      ? onOpenStop({
                          id: leg.from.id,
                          name: leg.from.name ?? '',
                          lat: leg.from.lat,
                          lon: leg.from.lon,
                        })
                      : undefined
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Pokaż ${leg.from.name} na mapie`}>
                  <ThemedText type="callout" numberOfLines={1}>
                    {clock(leg.departure)} · {leg.from.name}
                  </ThemedText>
                </Pressable>
                <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
                  {leg.headsign ? `w kierunku ${leg.headsign}` : leg.direction}
                </ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
                  {clock(leg.arrival)} · {leg.to.name} ·{' '}
                  {Math.max(1, leg.stops.length - 1)}{' '}
                  {plural(Math.max(1, leg.stops.length - 1), [
                    'przystanek',
                    'przystanki',
                    'przystanków',
                  ])}
                </ThemedText>
                {leg.wheelchair === true && (
                  <View style={styles.legFlag}>
                    <Ionicons name="accessibility" size={12} color={theme.textSecondary} />
                    <ThemedText type="caption" themeColor="textSecondary">
                      niskopodłogowy
                    </ThemedText>
                  </View>
                )}
              </View>
            </>
          )}
        </View>
      ))}

      <Divider />

      <Pressable
        onPress={() => {
          for (const ride of rides) favouritesStore.toggleLine(ride.line);
          tapped();
        }}
        accessibilityRole="button"
        accessibilityLabel="Obserwuj linie z tej trasy"
        style={({ pressed }) => [styles.follow, pressed && styles.pressed]}>
        <Ionicons name="star-outline" size={15} color={theme.accent} />
        <ThemedText type="footnote" weight="semibold" color={theme.accent}>
          Obserwuj linie z tej trasy
        </ThemedText>
      </Pressable>
    </Section>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.lg },
  endpoint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    minHeight: 50,
  },
  endpointLabel: { flex: 1, minWidth: 0, justifyContent: 'center', minHeight: 50 },
  swap: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, alignSelf: 'flex-end' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 44,
    paddingHorizontal: Space.md,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: Type.body.fontSize, fontWeight: Weight.regular, minHeight: 44 },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    minHeight: 48,
  },
  resultText: { flex: 1, gap: 1, minWidth: 0 },
  when: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  chip: {
    paddingHorizontal: Space.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  centered: { paddingVertical: Space.xl, alignItems: 'center' },
  walkOnly: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    minHeight: 48,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingTop: Space.md,
  },
  planTimes: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  planClock: { fontVariant: ['tabular-nums'] },
  planMeta: { alignItems: 'flex-end', gap: 1 },
  planSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Space.sm,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  planSummaryItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  leg: {
    flexDirection: 'row',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  legIcon: { marginTop: 2 },
  legText: { flex: 1, gap: 2, minWidth: 0 },
  legFlag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  follow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    minHeight: 44,
  },
  pressed: { opacity: Motion.pressedOpacity },
});
