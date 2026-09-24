import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { ModalScreen } from '@/components/modal-screen';
import { StopAreaRow } from '@/components/stop-area-row';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space, Type, Weight } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { getJourneyDepartures, type Departure } from '@/lib/api';
import { arrivalSeconds, clockIn, departureSeconds } from '@/lib/departures';
import { etaParts } from '@/lib/format';
import { useFavouriteStops } from '@/lib/favourite-stops';
import {
  favouriteTripsStore,
  MAX_FAVOURITE_TRIPS,
  MAX_TRIP_LABEL_LENGTH,
  useFavouriteTrips,
  type TripPlace,
} from '@/lib/favourite-trips';
import { failed, tapped } from '@/lib/haptics';
import { groupStopAreas, searchStops, type StopArea } from '@/lib/stops-api';

const DEBOUNCE_MS = 220;

/** Every platform of a place: the server's `?to=` filter picks the direction. */
const toPlace = (area: StopArea): TripPlace => ({
  name: area.name,
  ids: [...new Set(area.platforms.flatMap((platform) => [platform.id, ...(platform.ids ?? [])]))],
  lat: area.primary.lat,
  lon: area.primary.lon,
});

type Step = 'from' | 'to' | 'name';

/**
 * Saving a journey: where from, where to, what to call it.
 *
 * Both ends are chosen as *places*, not platforms — which side of the street
 * is exactly the thing a rider should not have to know, and the server works
 * it out by keeping only the trips that reach the destination. The last step
 * shows what the trip looks like right now, so a pair with no direct service
 * ("nothing goes from here to there") is found out before it is saved, not on
 * the widget at 7:40.
 */
export default function NewTripScreen() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const trips = useFavouriteTrips();
  const [step, setStep] = useState<Step>('from');
  const [from, setFrom] = useState<TripPlace | null>(null);
  const [to, setTo] = useState<TripPlace | null>(null);
  const [label, setLabel] = useState('');

  const full = trips.length >= MAX_FAVOURITE_TRIPS;

  const save = () => {
    if (!from || !to) return;
    const saved = favouriteTripsStore.add(from, to, label);
    if (!saved) {
      failed();
      return;
    }
    tapped();
    router.back();
  };

  return (
    <ModalScreen
      title="Nowy przejazd"
      subtitle={step === 'from' ? 'Skąd jedziesz?' : step === 'to' ? `Z: ${from?.name ?? ''} — dokąd?` : 'Sprawdź i nazwij'}>
      {full ? (
        <View style={styles.centered}>
          <ThemedText type="headline">Masz już {MAX_FAVOURITE_TRIPS} przejazdów</ThemedText>
          <ThemedText type="footnote" themeColor="textSecondary" style={styles.centeredText}>
            Usuń jeden w ulubionych, aby zapisać nowy.
          </ThemedText>
        </View>
      ) : step === 'from' ? (
        <PlacePicker
          key="from"
          placeholder="Przystanek początkowy, np. Biskupin"
          onPick={(place) => {
            setFrom(place);
            setStep('to');
          }}
        />
      ) : step === 'to' ? (
        <PlacePicker
          key="to"
          placeholder="Przystanek docelowy, np. Reja"
          exclude={from?.name ?? null}
          onBack={() => setStep('from')}
          onPick={(place) => {
            setTo(place);
            setStep('name');
          }}
        />
      ) : (
        from &&
        to && (
          <View style={[styles.review, { paddingBottom: insets.bottom + Space.xl }]}>
            <View style={[styles.route, { backgroundColor: theme.backgroundCard }]}>
              <RouteEnd icon="radio-button-on" label="Z" name={from.name} onEdit={() => setStep('from')} />
              <View style={[styles.routeLine, { backgroundColor: theme.separator }]} />
              <RouteEnd icon="flag" label="Do" name={to.name} onEdit={() => setStep('to')} />
            </View>

            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Nazwa, np. Szkoła (opcjonalnie)"
              placeholderTextColor={theme.textTertiary}
              maxLength={MAX_TRIP_LABEL_LENGTH}
              returnKeyType="done"
              accessibilityLabel="Nazwa przejazdu"
              style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
            />

            <Preview from={from} to={to} />

            <Pressable
              onPress={save}
              accessibilityRole="button"
              style={({ pressed }) => [styles.save, { backgroundColor: theme.accent }, pressed && styles.pressed]}>
              <ThemedText type="callout" weight="semibold" color="#ffffff">
                Zapisz przejazd
              </ThemedText>
            </Pressable>
          </View>
        )
      )}
    </ModalScreen>
  );
}

function RouteEnd({
  icon,
  label,
  name,
  onEdit,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  name: string;
  onEdit: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onEdit}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${name}. Zmień`}
      style={({ pressed }) => [styles.routeEnd, pressed && styles.pressed]}>
      <Ionicons name={icon} size={16} color={theme.textSecondary} />
      <View style={styles.routeText}>
        <ThemedText type="caption" themeColor="textSecondary">
          {label.toLocaleUpperCase('pl')}
        </ThemedText>
        <ThemedText type="body" weight="semibold" numberOfLines={1}>
          {name}
        </ThemedText>
      </View>
      <ThemedText type="footnote" weight="semibold" color={theme.accent}>
        Zmień
      </ThemedText>
    </Pressable>
  );
}

/** What the trip looks like now — the check that something actually goes there. */
function Preview({ from, to }: { from: TripPlace; to: TripPlace }) {
  const theme = useTheme();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ok'; departures: Departure[]; supported: boolean }
  >({ status: 'loading' });
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    getJourneyDepartures(from.ids, to.ids, { signal: controller.signal })
      .then((board) => {
        if (!controller.signal.aborted) setState({ status: 'ok', ...board });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [from, to]);

  return (
    <View style={[styles.preview, { backgroundColor: theme.backgroundCard }]}>
      <ThemedText type="caption" weight="semibold" themeColor="textSecondary">
        NAJBLIŻSZE POŁĄCZENIA
      </ThemedText>
      {state.status === 'loading' ? (
        <ActivityIndicator style={styles.previewSpinner} />
      ) : state.status === 'error' ? (
        <ThemedText type="footnote" themeColor="textSecondary">
          Nie udało się sprawdzić połączeń. Przejazd i tak możesz zapisać.
        </ThemedText>
      ) : !state.supported ? (
        <ThemedText type="footnote" themeColor="textSecondary">
          Serwer jeszcze nie podaje czasów przyjazdu. Przejazd zapiszemy i pokażemy, gdy zacznie.
        </ThemedText>
      ) : state.departures.length === 0 ? (
        <ThemedText type="footnote" themeColor="textSecondary">
          W najbliższych godzinach nic nie jedzie bezpośrednio z {from.name} do {to.name}. Przesiadek jeszcze nie
          liczymy.
        </ThemedText>
      ) : (
        state.departures.slice(0, 4).map((departure) => {
          const eta = etaParts(departureSeconds(departure));
          const arrives = arrivalSeconds(departure);
          return (
            <View key={`${departure.tripId}-${departure.departure}`} style={styles.previewRow}>
              <LineBadge line={departure.line} type={departure.type} size="small" />
              <ThemedText type="callout" style={styles.previewText} numberOfLines={1}>
                {arrives === null ? departure.headsign : `na miejscu ${clockIn(arrives, now)}`}
              </ThemedText>
              <ThemedText type="callout" weight="semibold" color={theme.amber}>
                {eta.unit ? `${eta.value} ${eta.unit}` : eta.value}
              </ThemedText>
            </View>
          );
        })
      )}
    </View>
  );
}

/** Search for a place, with starred stops offered before anything is typed. */
function PlacePicker({
  placeholder,
  exclude,
  onPick,
  onBack,
}: {
  placeholder: string;
  exclude?: string | null;
  onPick: (place: TripPlace) => void;
  onBack?: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const favourites = useFavouriteStops();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; areas: StopArea[] } | null>(null);
  const [error, setError] = useState(false);
  const needle = query.trim();

  useEffect(() => {
    if (needle.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchStops(needle, { signal: controller.signal })
        .then((stops) => {
          if (controller.signal.aborted) return;
          setError(false);
          setResults({ query: needle, areas: groupStopAreas(stops) });
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [needle]);

  // Starred stops, as places — so "Dom" is one tap, not a search.
  const suggestions = useMemo(
    () => groupStopAreas(favourites.map((stop) => ({ ...stop }))),
    [favourites],
  );
  const searching = needle.length >= 2;
  const areas = (searching ? (results?.query === needle ? results.areas : []) : suggestions).filter(
    (area) => area.name !== exclude,
  );
  const loading = searching && results?.query !== needle && !error;

  return (
    <View style={styles.picker}>
      <View style={styles.searchRow}>
        {onBack && (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Wstecz"
            style={({ pressed }) => [styles.back, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
            <Ionicons name="arrow-back" size={18} color={theme.text} />
          </Pressable>
        )}
        <View style={[styles.search, { backgroundColor: theme.backgroundElement }]}>
          <Ionicons name="search" size={18} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={placeholder}
            placeholderTextColor={theme.textSecondary}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            inputMode="search"
            returnKeyType="search"
            accessibilityLabel={placeholder}
            style={[styles.searchInput, { color: theme.text }]}
          />
        </View>
      </View>

      <FlatList
        data={areas}
        keyExtractor={(area) => `${area.name}-${area.primary.id}`}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + Space.xxl }}
        ListHeaderComponent={
          !searching && areas.length > 0 ? (
            <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" style={styles.listTitle}>
              ULUBIONE
            </ThemedText>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.previewSpinner} />
          ) : searching ? (
            <ThemedText type="footnote" themeColor="textSecondary" style={styles.listTitle}>
              {error ? 'Nie udało się wyszukać.' : `Brak przystanków „${needle}”.`}
            </ThemedText>
          ) : (
            <ThemedText type="footnote" themeColor="textSecondary" style={styles.listTitle}>
              Wpisz co najmniej dwie litery nazwy przystanku.
            </ThemedText>
          )
        }
        renderItem={({ item }) => (
          <StopAreaRow
            area={item}
            trailing={<Ionicons name="chevron-forward" size={17} color={theme.textTertiary} />}
            onPress={() => {
              tapped();
              onPick(toPlace(item));
            }}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.sm, padding: Space.xxl },
  centeredText: { textAlign: 'center' },
  picker: { flex: 1 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingHorizontal: Space.lg, paddingBottom: Space.sm },
  back: { width: 40, height: 40, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  search: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.md,
  },
  searchInput: { ...Type.body, flex: 1, minWidth: 0, fontWeight: Weight.medium, paddingVertical: 0 },
  listTitle: { paddingHorizontal: Space.lg, paddingTop: Space.md, paddingBottom: Space.xs, letterSpacing: 0.5 },
  review: { flex: 1, paddingHorizontal: Space.lg, gap: Space.md },
  route: { borderRadius: Radius.lg, paddingHorizontal: Space.lg },
  routeEnd: { flexDirection: 'row', alignItems: 'center', gap: Space.md, minHeight: 56 },
  routeText: { flex: 1, minWidth: 0 },
  routeLine: { height: StyleSheet.hairlineWidth, marginLeft: Space.xxl },
  input: { ...Type.body, minHeight: 48, borderRadius: Radius.md, paddingHorizontal: Space.md },
  preview: { borderRadius: Radius.lg, padding: Space.lg, gap: Space.sm },
  previewSpinner: { paddingVertical: Space.md },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, minHeight: 32 },
  previewText: { flex: 1, minWidth: 0 },
  save: { minHeight: 50, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: Motion.pressedOpacity },
});
