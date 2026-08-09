import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { etaParts, plural } from '@/lib/format';
import {
  getAllLocations,
  getDeparturesForStops,
  getLines,
  type Departure,
  type FleetVehicle,
  type LineType,
  type Lines,
  type Stop,
} from '@/lib/api';
import { CATEGORY_ORDER, compareLines } from '@/lib/lines';
import { mapIntentStore } from '@/lib/map-intent';
import { recentStopsStore, useRecentStops } from '@/lib/recent-stops';
import { selectionStore } from '@/lib/selection';
import { searchStops } from '@/lib/stops-api';

const STOP_MIN_QUERY = 2;
const DEBOUNCE_MS = 220;

type LineResult = { line: string; type: LineType };
type SearchResult =
  | { kind: 'stop'; value: Stop }
  | { kind: 'line'; value: LineResult }
  | { kind: 'vehicle'; value: FleetVehicle };
type Results = { stops: Stop[]; lines: LineResult[]; vehicles: FleetVehicle[] };
type ResultSection = { key: SearchResult['kind']; title: string; data: SearchResult[] };

const EMPTY_RESULTS: Results = { stops: [], lines: [], vehicles: [] };

/**
 * One search for the things a rider can act on.
 *
 * The older screen made people choose a silo before they could type. This
 * screen deliberately keeps the destination, route and live vehicle matches
 * together: type the one clue you have, then open the useful result on the map.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const recent = useRecentStops();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const [resultQuery, setResultQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stopChoices, setStopChoices] = useState<Stop[] | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const needle = query.trim();

  useEffect(() => {
    requestRef.current?.abort();
    if (!needle) return;

    const timer = setTimeout(() => {
      const controller = new AbortController();
      requestRef.current = controller;
      setLoading(true);
      setError(false);

      const uppercaseNeedle = needle.toLocaleUpperCase('pl');
      const requests = [
        needle.length >= STOP_MIN_QUERY
          ? searchStops(needle, { signal: controller.signal })
          : Promise.resolve<Stop[]>([]),
        getLines({ signal: controller.signal }).then((data) => filterLines(data, uppercaseNeedle)),
        getAllLocations({ signal: controller.signal }).then(({ locations }) =>
          locations.filter((vehicle) => matchesVehicle(vehicle, uppercaseNeedle)),
        ),
      ] as const;

      Promise.allSettled(requests)
        .then(([stops, lines, vehicles]) => {
          if (controller.signal.aborted) return;
          setResults({
            stops: stops.status === 'fulfilled' ? stops.value : [],
            lines: lines.status === 'fulfilled' ? lines.value : [],
            vehicles: vehicles.status === 'fulfilled' ? vehicles.value : [],
          });
          const attempted = needle.length >= STOP_MIN_QUERY ? [stops, lines, vehicles] : [lines, vehicles];
          setError(attempted.every((result) => result.status === 'rejected'));
          setResultQuery(needle);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [needle, refreshKey]);

  // Results are only ever shown for the exact text that produced them. It
  // avoids a stale match list flashing under a newly edited query, without a
  // synchronous "clear results" state update inside the effect above.
  const visibleResults = resultQuery === needle ? results : EMPTY_RESULTS;
  const isSearching = !!needle && (loading || resultQuery !== needle);
  const activeError = error && resultQuery === needle;
  const sameNameAreaCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stop of visibleResults.stops) {
      const key = normaliseStopName(stop.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [visibleResults.stops]);
  const sections = useMemo<ResultSection[]>(() => {
    const all: ResultSection[] = [
      { key: 'stop', title: 'Przystanki', data: visibleResults.stops.map((value) => ({ kind: 'stop', value })) },
      { key: 'line', title: 'Linie', data: visibleResults.lines.map((value) => ({ kind: 'line', value })) },
      { key: 'vehicle', title: 'Pojazdy na żywo', data: visibleResults.vehicles.map((value) => ({ kind: 'vehicle', value })) },
    ];
    return all.filter((section) => section.data.length > 0);
  }, [visibleResults]);

  const openStop = useCallback((stop: Stop) => {
    recentStopsStore.add(stop);
    mapIntentStore.openStop(stop);
    router.back();
  }, [router]);
  const selectStop = useCallback((stop: Stop) => {
    const sameNamedAreas = visibleResults.stops.filter(
      (candidate) => normaliseStopName(candidate.name) === normaliseStopName(stop.name),
    );
    if (sameNamedAreas.length > 1) {
      setStopChoices(sameNamedAreas);
      return;
    }
    openStop(stop);
  }, [openStop, visibleResults.stops]);
  const selectVehicle = useCallback((vehicle: FleetVehicle) => {
    mapIntentStore.openVehicle(vehicle);
    router.back();
  }, [router]);

  const showStart = !needle;
  const showNoResults = !!needle && !isSearching && !activeError && sections.length === 0;

  return (
    <ModalScreen title="Szukaj" subtitle="Przystanki, linie i pojazdy">
      <View style={styles.searchArea}>
        <View
          style={[
            styles.search,
            { backgroundColor: theme.backgroundElement, borderColor: theme.separator },
          ]}>
          <Ionicons name="search" size={20} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={(text) => {
              setStopChoices(null);
              setQuery(text);
            }}
            placeholder="Dokąd jedziesz?"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { color: theme.text }]}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            inputMode="search"
            returnKeyType="search"
            accessibilityLabel="Szukaj przystanku, linii lub pojazdu"
          />
          {!!query && (
            <Pressable
              onPress={() => {
                setStopChoices(null);
                setQuery('');
              }}
              accessibilityRole="button"
              accessibilityLabel="Wyczyść wyszukiwanie"
              hitSlop={10}>
              <Ionicons name="close-circle" size={20} color={theme.textSecondary} />
            </Pressable>
          )}
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.searchHint}>
          Wpisz nazwę, numer linii albo kierunek.
        </ThemedText>
      </View>

      {stopChoices ? (
        <StopAreaChooser
          stops={stopChoices}
          onBack={() => setStopChoices(null)}
          onSelect={openStop}
        />
      ) : showStart ? (
        <StartState
          recent={recent}
          bottomInset={insets.bottom}
          onSelectStop={openStop}
          onClearRecents={() => recentStopsStore.clear()}
          onBrowseLines={() => router.push('/lines')}
        />
      ) : isSearching && sections.length === 0 ? (
        <LoadingState />
      ) : activeError ? (
        <FailureState onRetry={() => setRefreshKey((value) => value + 1)} />
      ) : showNoResults ? (
        <NoResults query={needle} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => {
            if (item.kind === 'stop') return `stop-${item.value.id}`;
            if (item.kind === 'line') return `line-${item.value.line}`;
            return `vehicle-${item.value.id}`;
          }}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                {section.title}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {section.data.length}
              </ThemedText>
            </View>
          )}
          renderItem={({ item }) => {
            if (item.kind === 'stop') {
              return (
                <StopRow
                  stop={item.value}
                  alternativeCount={sameNameAreaCounts.get(normaliseStopName(item.value.name)) ?? 1}
                  onPress={() => selectStop(item.value)}
                />
              );
            }
            if (item.kind === 'line') {
              return <LineRow line={item.value} onPress={() => {
                selectionStore.set([item.value.line]);
                mapIntentStore.openLine(item.value.line, item.value.type);
                router.back();
              }} />;
            }
            return <VehicleRow vehicle={item.value} onPress={() => selectVehicle(item.value)} />;
          }}
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.results, { paddingBottom: insets.bottom + Spacing.five }]}
          ListFooterComponent={isSearching ? <InlineLoading /> : null}
        />
      )}
    </ModalScreen>
  );
}

function filterLines(data: Lines, needle: string): LineResult[] {
  const lines = new Map<string, LineResult>();
  for (const type of CATEGORY_ORDER) {
    for (const line of data[type] ?? []) {
      if (line.toLocaleUpperCase('pl').includes(needle)) lines.set(line, { line, type });
    }
  }
  return [...lines.values()].sort((a, b) => compareLines(a.line, b.line));
}

function matchesVehicle(vehicle: FleetVehicle, needle: string) {
  return [
    vehicle.line,
    vehicle.id,
    vehicle.vehicleLabel ?? '',
    vehicle.trip?.headsign ?? '',
    vehicle.trip?.towards ?? '',
  ].join(' ').toLocaleUpperCase('pl').includes(needle);
}

function normaliseStopName(name: string) {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[łŁ]/g, 'l')
    .toLocaleLowerCase('pl-PL')
    .trim();
}

type StopAreaBoard = {
  stop: Stop;
  departures: Departure[];
};

/**
 * Same names do not imply one boarding point: terminus loops and interchange
 * stops routinely put bus and tram platforms dozens of metres apart. Make the
 * choice explicit and identify it by the services actually leaving from it.
 */
function StopAreaChooser({
  stops,
  onBack,
  onSelect,
}: {
  stops: Stop[];
  onBack: () => void;
  onSelect: (stop: Stop) => void;
}) {
  const theme = useTheme();
  const [boards, setBoards] = useState<StopAreaBoard[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all(
      stops.map(async (stop) => {
        try {
          const board = await getDeparturesForStops(stop, { signal: controller.signal });
          return { stop, departures: board.departures };
        } catch {
          return { stop, departures: [] };
        }
      }),
    ).then((nextBoards) => {
      if (!controller.signal.aborted) setBoards(nextBoards);
    });
    return () => controller.abort();
  }, [stops]);

  const ordered = useMemo(() => {
    if (!boards) return [];
    return [...boards].sort((a, b) => serviceRank(a.departures) - serviceRank(b.departures));
  }, [boards]);

  const name = stops[0]?.name ?? 'Przystanek';
  return (
    <View style={styles.chooser}>
      <View style={styles.chooserHeader}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Wróć do wyników"
          style={({ pressed }) => [styles.backButton, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
          <Ionicons name="arrow-back" size={18} color={theme.text} />
        </Pressable>
        <View style={styles.chooserTitle}>
          <ThemedText type="defaultSemiBold" numberOfLines={1}>{name}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">Wybierz właściwe stanowisko</ThemedText>
        </View>
      </View>

      {!boards ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.accent} />
          <ThemedText type="small" themeColor="textSecondary">Sprawdzamy odjazdy na każdym stanowisku…</ThemedText>
        </View>
      ) : (
        <SectionList
          sections={[{ title: 'Stanowiska', data: ordered }]}
          keyExtractor={({ stop }) => stop.id}
          renderSectionHeader={() => (
            <View style={styles.chooserHint}>
              <ThemedText type="small" themeColor="textSecondary">
                Linie pokazują, z którego miejsca odjeżdżają.
              </ThemedText>
            </View>
          )}
          renderItem={({ item }) => (
            <PlatformRow board={item} onPress={() => onSelect(item.stop)} />
          )}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.chooserList}
        />
      )}
    </View>
  );
}

function PlatformRow({ board, onPress }: { board: StopAreaBoard; onPress: () => void }) {
  const theme = useTheme();
  const lines = uniqueLines(board.departures);
  const hasTram = lines.some(({ type }) => type.startsWith('tram'));
  const hasBus = lines.some(({ type }) => type.startsWith('bus'));
  const label = hasTram && hasBus ? 'Tramwaje i autobusy' : hasTram ? 'Tramwaje' : hasBus ? 'Autobusy' : 'Brak bieżących odjazdów';
  const platform = board.stop.code ? `Stanowisko ${board.stop.code}` : 'Stanowisko bez numeru';
  const next = board.departures[0];
  const eta = etaParts(next?.inSeconds);
  const nextDeparture = next
    ? eta.value === 'teraz'
      ? `Najbliższy · ${next.line} teraz`
      : `Najbliższy · ${next.line} za ${eta.value}${eta.unit ? ` ${eta.unit}` : ''}`
    : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${platform}, ${label}`}
      style={({ pressed }) => [styles.platformRow, { borderColor: theme.separator }, pressed && styles.pressed]}>
      <View style={[styles.platformIcon, { backgroundColor: hasTram ? 'rgba(11,95,191,0.12)' : theme.backgroundElement }]}>
        <Ionicons name={hasTram ? 'train-outline' : 'bus-outline'} size={21} color={hasTram ? '#0B5FBF' : theme.textSecondary} />
      </View>
      <View style={styles.rowText}>
        <ThemedText type="defaultSemiBold">{platform}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">{label}</ThemedText>
        {nextDeparture && <ThemedText type="small" themeColor="textSecondary">{nextDeparture}</ThemedText>}
        {lines.length > 0 && (
          <View style={styles.platformBadges}>
            {lines.slice(0, 5).map(({ line, type }) => <LineBadge key={line} line={line} type={type} size="small" />)}
            {lines.length > 5 && <ThemedText type="small" themeColor="textSecondary">+{lines.length - 5}</ThemedText>}
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

function uniqueLines(departures: Departure[]) {
  const lines = new Map<string, Pick<Departure, 'line' | 'type'>>();
  for (const departure of departures) lines.set(departure.line, departure);
  return [...lines.values()].sort((a, b) => compareLines(a.line, b.line));
}

function serviceRank(departures: Departure[]) {
  const types = departures.map((departure) => departure.type);
  if (types.some((type) => type.startsWith('tram'))) return 0;
  if (types.some((type) => type === 'bus')) return 1;
  if (types.some((type) => type.startsWith('bus'))) return 2;
  return 3;
}

function StartState({
  recent,
  bottomInset,
  onSelectStop,
  onClearRecents,
  onBrowseLines,
}: {
  recent: Stop[];
  bottomInset: number;
  onSelectStop: (stop: Stop) => void;
  onClearRecents: () => void;
  onBrowseLines: () => void;
}) {
  const theme = useTheme();
  return (
    <SectionList
      sections={recent.length ? [{ title: 'Ostatnie przystanki', data: recent }] : []}
      keyExtractor={(item) => item.id}
      renderSectionHeader={({ section }) => (
        <View style={styles.startSectionHeader}>
          <ThemedText type="smallBold" themeColor="textSecondary">{section.title}</ThemedText>
          <Pressable onPress={onClearRecents} accessibilityRole="button" accessibilityLabel="Wyczyść ostatnie przystanki">
            <ThemedText type="small" style={{ color: theme.accent }}>Wyczyść</ThemedText>
          </Pressable>
        </View>
      )}
      renderItem={({ item }) => <StopRow stop={item} onPress={() => onSelectStop(item)} />}
      ListHeaderComponent={
        <View style={styles.welcome}>
          <View style={[styles.welcomeIcon, { backgroundColor: theme.backgroundElement }]}>
            <Ionicons name="navigate-outline" size={25} color={theme.text} />
          </View>
          <ThemedText type="defaultSemiBold">Znajdź swój przejazd</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.welcomeText}>
            Wyniki otwierają się od razu na mapie z najbliższymi odjazdami.
          </ThemedText>
          <Pressable
            onPress={onBrowseLines}
            accessibilityRole="button"
            style={({ pressed }) => [styles.browseLines, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
            <Ionicons name="git-branch-outline" size={18} color={theme.text} />
            <ThemedText type="smallBold">Przeglądaj linie</ThemedText>
            <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
          </Pressable>
        </View>
      }
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.startContent, { paddingBottom: bottomInset + Spacing.five }]}
    />
  );
}

function StopRow({
  stop,
  alternativeCount = 1,
  onPress,
}: {
  stop: Stop;
  alternativeCount?: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const hasChoice = alternativeCount > 1;
  const meta = hasChoice
    ? `${alternativeCount} ${plural(alternativeCount, ['lokalizacja', 'lokalizacje', 'lokalizacji'])} · wybierz stanowisko`
    : stop.code
      ? `Stanowisko ${stop.code}`
      : 'Stanowisko';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${stop.name}${hasChoice ? `, ${meta}` : ''}`}
      style={({ pressed }) => [styles.row, { borderBottomColor: theme.separator }, pressed && styles.pressed]}>
      <ResultIcon name={hasChoice ? 'git-branch-outline' : 'location-outline'} highlighted={hasChoice} />
      <View style={styles.rowText}>
        <ThemedText>{stop.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>{meta}</ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

function LineRow({ line, onPress }: { line: LineResult; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Pokaż linię ${line.line}`} style={({ pressed }) => [styles.row, { borderBottomColor: theme.separator }, pressed && styles.pressed]}>
      <LineBadge line={line.line} type={line.type} />
      <View style={styles.rowText}>
        <ThemedText>Linia {line.line}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">Pokaż trasę i pojazdy na mapie</ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

function VehicleRow({ vehicle, onPress }: { vehicle: FleetVehicle; onPress: () => void }) {
  const theme = useTheme();
  const direction = vehicle.trip?.towards || vehicle.trip?.headsign || 'Kierunek nieznany';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Pojazd linii ${vehicle.line}`} style={({ pressed }) => [styles.row, { borderBottomColor: theme.separator }, pressed && styles.pressed]}>
      <LineBadge line={vehicle.line} type={vehicle.type} />
      <View style={styles.rowText}>
        <ThemedText numberOfLines={1}>{vehicle.vehicleLabel || `Pojazd ${vehicle.id}`}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>Linia {vehicle.line} · {direction}</ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

function ResultIcon({
  name,
  highlighted = false,
}: {
  name: 'location-outline' | 'git-branch-outline';
  highlighted?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.resultIcon, { backgroundColor: highlighted ? 'rgba(11,95,191,0.12)' : theme.backgroundElement }]}>
      <Ionicons name={name} size={19} color={highlighted ? '#0B5FBF' : theme.textSecondary} />
    </View>
  );
}

function LoadingState() {
  const theme = useTheme();
  return <View style={styles.centered}><ActivityIndicator color={theme.accent} /><ThemedText type="small" themeColor="textSecondary">Szukamy po mieście…</ThemedText></View>;
}
function InlineLoading() { const theme = useTheme(); return <View style={styles.inlineLoading}><ActivityIndicator size="small" color={theme.accent} /></View>; }
function NoResults({ query }: { query: string }) { const theme = useTheme(); return <View style={styles.centered}><Ionicons name="search-outline" size={30} color={theme.textSecondary} /><ThemedText type="defaultSemiBold">Brak wyników dla „{query}”</ThemedText><ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>Sprawdź pisownię albo spróbuj nazwy części przystanku.</ThemedText></View>; }
function FailureState({ onRetry }: { onRetry: () => void }) { const theme = useTheme(); return <View style={styles.centered}><Ionicons name="cloud-offline-outline" size={30} color={theme.textSecondary} /><ThemedText type="defaultSemiBold">Nie udało się wyszukać</ThemedText><Pressable onPress={onRetry} accessibilityRole="button"><ThemedText type="linkPrimary">Spróbuj ponownie</ThemedText></Pressable></View>; }

const styles = StyleSheet.create({
  searchArea: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.two, gap: Spacing.one },
  search: { minHeight: 52, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingHorizontal: Spacing.three },
  input: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '500', paddingVertical: 0 },
  searchHint: { paddingHorizontal: Spacing.one, },
  results: { paddingBottom: Spacing.five },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.one },
  row: { minHeight: 68, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  rowText: { flex: 1, gap: 1 },
  resultIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.five },
  inlineLoading: { alignItems: 'center', paddingVertical: Spacing.three },
  emptyText: { textAlign: 'center', maxWidth: 280 },
  pressed: { opacity: 0.6 },
  chooser: { flex: 1 },
  chooserHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.two },
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  chooserTitle: { flex: 1, gap: 1 },
  chooserHint: { paddingHorizontal: Spacing.three, paddingTop: Spacing.one, paddingBottom: Spacing.two },
  chooserList: { paddingBottom: Spacing.five },
  platformRow: { minHeight: 82, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  platformIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  platformBadges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: Spacing.one },
  startContent: { paddingBottom: Spacing.five },
  welcome: { alignItems: 'center', paddingHorizontal: Spacing.five, paddingTop: Spacing.four, paddingBottom: Spacing.four, gap: Spacing.one },
  welcomeIcon: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.one },
  welcomeText: { textAlign: 'center', maxWidth: 275 },
  browseLines: { alignSelf: 'stretch', minHeight: 48, marginTop: Spacing.two, borderRadius: 15, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  startSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.one },
});
