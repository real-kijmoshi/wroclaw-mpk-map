import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { LineBadge } from '@/components/line-badge';
import { Divider, Section } from '@/components/list';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { getDepartures, type Departure } from '@/lib/api';
import { formatScheduled } from '@/lib/format';
import { tapped } from '@/lib/haptics';

/**
 * The whole board, not just the next few minutes.
 *
 * The sheet answers "when is the next one", which is the question at a stop.
 * This answers "when is the last one" and "what time does it run on a Sunday"
 * — the questions asked from an armchair, and the ones that previously sent
 * people to the operator's PDF.
 *
 * It exists because `getDepartures` has always taken a `now` and the endpoint
 * finally passes one through. Boards away from the present carry no live
 * ETAs by design: a prediction is a claim about a vehicle moving right now,
 * and on tomorrow's board it would be measured from the wrong moment. So this
 * screen shows scheduled times only, and never pretends otherwise.
 */

const HOW_MANY = 60;

type Window = { label: string; at: () => Date | undefined };

/**
 * The four times anyone actually asks about.
 *
 * "Jutro rano" is 06:00 rather than midnight because the question behind it is
 * "what gets me to work", and a board starting at 00:00 answers it with the
 * night bus.
 */
const WINDOWS: Window[] = [
  { label: 'Teraz', at: () => undefined },
  { label: 'Za godzinę', at: () => new Date(Date.now() + 3_600_000) },
  { label: 'Wieczorem', at: () => atHour(0, 20) },
  { label: 'Jutro rano', at: () => atHour(1, 6) },
];

function atHour(dayOffset: number, hour: number): Date {
  const when = new Date();
  when.setDate(when.getDate() + dayOffset);
  when.setHours(hour, 0, 0, 0);
  return when;
}

export default function TimetableScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ stopId?: string; name?: string }>();
  const stopId = params.stopId ?? '';
  const stopName = params.name ?? 'Rozkład';

  const [windowIndex, setWindowIndex] = useState(0);
  /*
   * Tagged with the request it answers, so "loading" is derived from the
   * answer being out of date rather than being a flag an effect has to set
   * and then clear on every exit path. Same pattern as the planner screen.
   */
  const [answer, setAnswer] = useState<
    { key: string; departures: Departure[] } | { key: string; failed: true } | null
  >(null);

  const key = `${stopId}|${windowIndex}`;

  useEffect(() => {
    if (!stopId) return;
    const controller = new AbortController();

    getDepartures(stopId, {
      signal: controller.signal,
      at: WINDOWS[windowIndex].at(),
      limit: HOW_MANY,
      within: 1440,
    })
      .then((board) => setAnswer({ key, departures: board.departures }))
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setAnswer({ key, failed: true });
      });

    return () => controller.abort();
  }, [key, stopId, windowIndex]);

  const current = answer?.key === key ? answer : null;
  const loading = Boolean(stopId) && !current;
  const departures = current && 'departures' in current ? current.departures : null;
  const failed = Boolean(current && 'failed' in current);

  /** Grouped by the hour they leave in, which is how a printed board reads. */
  const byHour = useMemo(() => {
    const groups = new Map<string, Departure[]>();
    for (const departure of departures ?? []) {
      const hour = departure.departure.slice(0, 2);
      const bucket = groups.get(hour);
      if (bucket) bucket.push(departure);
      else groups.set(hour, [departure]);
    }
    return [...groups.entries()];
  }, [departures]);

  return (
    <ModalScreen title={stopName} subtitle="Rozkład jazdy">
      <View style={styles.content}>
        <View style={styles.windows}>
          {WINDOWS.map((option, index) => {
            const active = index === windowIndex;
            return (
              <Pressable
                key={option.label}
                onPress={() => {
                  setWindowIndex(index);
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

        {loading && (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        )}

        {failed && (
          <View style={styles.centered}>
            <ThemedText themeColor="textSecondary">Nie udało się pobrać rozkładu</ThemedText>
          </View>
        )}

        {departures?.length === 0 && (
          <View style={styles.centered}>
            <ThemedText themeColor="textSecondary">Brak odjazdów w tym czasie</ThemedText>
          </View>
        )}

        {byHour.map(([hour, departures]) => (
          <Section key={hour} title={`${hour}:00`}>
            {departures.map((departure, index) => (
              <View key={`${departure.tripId}-${departure.departure}`}>
                {index > 0 && <Divider />}
                <View style={styles.row}>
                  <LineBadge line={departure.line} type={departure.type} size="small" />
                  <View style={styles.rowText}>
                    <ThemedText type="callout" numberOfLines={1}>
                      {departure.headsign ?? '—'}
                    </ThemedText>
                    {departure.serviceDay === 'tomorrow' && (
                      <ThemedText type="footnote" themeColor="textTertiary">
                        jutro
                      </ThemedText>
                    )}
                  </View>
                  {departure.wheelchair === true && (
                    <Ionicons
                      name="accessibility"
                      size={14}
                      color={theme.textTertiary}
                      accessibilityLabel="Niskopodłogowy"
                    />
                  )}
                  <ThemedText type="headline" style={styles.time}>
                    {formatScheduled(departure.departure)}
                  </ThemedText>
                </View>
              </View>
            ))}
          </Section>
        ))}
      </View>
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.lg },
  windows: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  chip: {
    paddingHorizontal: Space.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  centered: { paddingVertical: Space.xl, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    minHeight: 48,
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  time: { fontVariant: ['tabular-nums'] },
  pressed: { opacity: Motion.pressedOpacity },
});
