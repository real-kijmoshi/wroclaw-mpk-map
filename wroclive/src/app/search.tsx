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
import { StopAreaRow } from '@/components/stop-area-row';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space, Type, Weight } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { etaParts } from '@/lib/format';
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
import { CATEGORY_ORDER, compareLines, LINE_COLOR } from '@/lib/lines';
import { mapIntentStore } from '@/lib/map-intent';
import { recentStopsStore, useRecentStops } from '@/lib/recent-stops';
import { selectionStore } from '@/lib/selection';
import { groupStopAreas, searchStops, type StopArea } from '@/lib/stops-api';

const STOP_MIN_QUERY = 2;
const DEBOUNCE_MS = 220;

type LineResult = { line: string; type: LineType };
type SearchResult =
  | { kind: 'stop'; value: StopArea }
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
  /**
   * One row per place, not per platform.
   *
   * Searching "Rynek" returned its four boarding points as four identical
   * rows — same name, same subtitle, same destination — which is the same
   * duplication the nearby list had. Grouped with `groupStopAreas`, the one
   * function that decides what counts as a single stop anywhere in the app.
   */
  const stopAreas = useMemo(() => groupStopAreas(visibleResults.stops), [visibleResults.stops]);

  const sections = useMemo<ResultSection[]>(() => {
    const all: ResultSection[] = [
      { key: 'stop', title: 'Przystanki', data: stopAreas.map((value) => ({ kind: 'stop', value })) },
      { key: 'line', title: 'Linie', data: visibleResults.lines.map((value) => ({ kind: 'line', value })) },
      { key: 'vehicle', title: 'Pojazdy na żywo', data: visibleResults.vehicles.map((value) => ({ kind: 'vehicle', value })) },
    ];
    return all.filter((section) => section.data.length > 0);
  }, [stopAreas, visibleResults]);

  const openStop = useCallback((stop: Stop) => {
    recentStopsStore.add(stop);
    mapIntentStore.openStop(stop);
    router.back();
  }, [router]);
  const selectStop = useCallback((area: StopArea) => {
    // Several boarding points under one name: which one matters, because they
    // face opposite directions. One boarding point: just open it.
    if (area.platforms.length > 1) {
      setStopChoices(area.platforms);
      return;
    }
    openStop(area.primary);
  }, [openStop]);
  const selectVehicle = useCallback((vehicle: FleetVehicle) => {
    mapIntentStore.openVehicle(vehicle);
    router.back();
  }, [router]);

  const showStart = !needle;
  const showNoResults = !!needle && !isSearching && !activeError && sections.length === 0;

  return (
    <ModalScreen title="Szukaj">
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
            placeholder="Szukaj linii, przystanku, pojazdu"
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
            if (item.kind === 'stop') return `stop-${item.value.primary.id}`;
            if (item.kind === 'line') return `line-${item.value.line}`;
            return `vehicle-${item.value.id}`;
          }}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
                {section.title.toLocaleUpperCase('pl')}
              </ThemedText>
              <ThemedText type="footnote" themeColor="textSecondary">
                {section.data.length}
              </ThemedText>
            </View>
          )}
          renderItem={({ item }) => {
            if (item.kind === 'stop') {
              return (
                <StopAreaRow
                  area={item.value}
                  trailing={<Ionicons name="chevron-forward" size={17} color={theme.textTertiary} />}
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
          // Without this the first tap on a result only dismisses the keyboard
          // and the rider has to tap the same row twice.
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.results, { paddingBottom: insets.bottom + Space.xxl }]}
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
          <ThemedText type="headline" numberOfLines={1}>{name}</ThemedText>
          <ThemedText type="footnote" themeColor="textSecondary">Wybierz właściwe stanowisko</ThemedText>
        </View>
      </View>

      {!boards ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.accent} />
          <ThemedText type="footnote" themeColor="textSecondary">Sprawdzamy odjazdy na każdym stanowisku…</ThemedText>
        </View>
      ) : (
        <SectionList
          sections={[{ title: 'Stanowiska', data: ordered }]}
          keyExtractor={({ stop }) => stop.id}
          renderSectionHeader={() => (
            <View style={styles.chooserHint}>
              <ThemedText type="footnote" themeColor="textSecondary">
                Linie pokazują, z którego miejsca odjeżdżają.
              </ThemedText>
            </View>
          )}
          renderItem={({ item }) => (
            <PlatformRow board={item} onPress={() => onSelect(item.stop)} />
          )}
          keyboardShouldPersistTaps="handled"
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
      {/*
        * A line colour is always drawn the way a LineBadge draws it: solid, with
        * white on top. That is the contrast the palette is built for (invariant
        * 11) — as a 16% tint the tram blue is a dark colour on a dark card and
        * the glyph disappears at 2.5:1.
        */}
      <View
        style={[
          styles.platformIcon,
          { backgroundColor: hasTram ? LINE_COLOR.tram : hasBus ? LINE_COLOR.bus : theme.textSecondary },
        ]}>
        <Ionicons name={hasTram ? 'train' : 'bus'} size={20} color="#ffffff" />
      </View>
      <View style={styles.rowText}>
        <ThemedText type="headline">{platform}</ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary">{label}</ThemedText>
        {nextDeparture && <ThemedText type="footnote" themeColor="textSecondary">{nextDeparture}</ThemedText>}
        {lines.length > 0 && (
          <View style={styles.platformBadges}>
            {lines.slice(0, 5).map(({ line, type }) => <LineBadge key={line} line={line} type={type} size="small" />)}
            {lines.length > 5 && <ThemedText type="footnote" themeColor="textSecondary">+{lines.length - 5}</ThemedText>}
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
          <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" style={styles.sectionLabel}>{section.title.toLocaleUpperCase('pl')}</ThemedText>
          <Pressable
            onPress={onClearRecents}
            accessibilityRole="button"
            accessibilityLabel="Wyczyść ostatnie przystanki"
            hitSlop={8}>
            <ThemedText type="footnote" weight="semibold" color={theme.accent}>Wyczyść</ThemedText>
          </Pressable>
        </View>
      )}
      renderItem={({ item }) => (
        <StopAreaRow
          area={asArea(item)}
          trailing={<Ionicons name="chevron-forward" size={17} color={theme.textTertiary} />}
          onPress={() => onSelectStop(item)}
        />
      )}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <View style={styles.welcome}>
          <View style={[styles.welcomeIcon, { backgroundColor: theme.backgroundElement }]}>
            <Ionicons name="navigate-outline" size={25} color={theme.text} />
          </View>
          <ThemedText type="headline">Znajdź swój przejazd</ThemedText>
          <ThemedText type="footnote" themeColor="textSecondary" style={styles.welcomeText}>
            Wyniki otwierają się od razu na mapie z najbliższymi odjazdami.
          </ThemedText>
          <Pressable
            onPress={onBrowseLines}
            accessibilityRole="button"
            style={({ pressed }) => [styles.browseLines, { backgroundColor: theme.backgroundElement }, pressed && styles.pressed]}>
            <Ionicons name="git-branch-outline" size={18} color={theme.text} />
            <ThemedText type="footnote" weight="semibold">Przeglądaj linie</ThemedText>
            <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
          </Pressable>
        </View>
      }
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.startContent, { paddingBottom: bottomInset + Space.xxl }]}
    />
  );
}

/**
 * A stop the rider already picked, as an area of one.
 *
 * A recent stop is a specific boarding point — the direction was chosen when it
 * was first opened — so it needs no chooser and is rendered by the same row as
 * everything else rather than by a second, nearly-identical component.
 */
const asArea = (stop: Stop): StopArea => ({
  primary: stop,
  name: stop.name,
  platforms: [stop],
  distance: stop.distance,
  lines: stop.lines ?? [],
});

function LineRow({ line, onPress }: { line: LineResult; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Pokaż linię ${line.line}`} style={({ pressed }) => [styles.row, { borderBottomColor: theme.separator }, pressed && styles.pressed]}>
      <LineBadge line={line.line} type={line.type} />
      <View style={styles.rowText}>
        <ThemedText>Linia {line.line}</ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary">Pokaż trasę i pojazdy na mapie</ThemedText>
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
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>Linia {vehicle.line} · {direction}</ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={17} color={theme.textSecondary} />
    </Pressable>
  );
}

function LoadingState() {
  const theme = useTheme();
  return <View style={styles.centered}><ActivityIndicator color={theme.accent} /><ThemedText type="footnote" themeColor="textSecondary">Szukamy po mieście…</ThemedText></View>;
}
function InlineLoading() { const theme = useTheme(); return <View style={styles.inlineLoading}><ActivityIndicator size="small" color={theme.accent} /></View>; }
function NoResults({ query }: { query: string }) { const theme = useTheme(); return <View style={styles.centered}><Ionicons name="search-outline" size={30} color={theme.textSecondary} /><ThemedText type="headline">Brak wyników dla „{query}”</ThemedText><ThemedText type="footnote" themeColor="textSecondary" style={styles.emptyText}>Sprawdź pisownię albo spróbuj nazwy części przystanku.</ThemedText></View>; }
function FailureState({ onRetry }: { onRetry: () => void }) { const theme = useTheme(); return <View style={styles.centered}><Ionicons name="cloud-offline-outline" size={30} color={theme.textSecondary} /><ThemedText type="headline">Nie udało się wyszukać</ThemedText><Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}><ThemedText type="callout" weight="semibold" color={theme.accent}>Spróbuj ponownie</ThemedText></Pressable></View>; }

const styles = StyleSheet.create({
  searchArea: { paddingHorizontal: Space.lg, paddingBottom: Space.sm },
  search: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.md,
  },
  input: { ...Type.headline, flex: 1, minWidth: 0, fontWeight: Weight.medium, paddingVertical: 0 },
  results: { paddingBottom: Space.xxl },
  sectionLabel: { letterSpacing: 0.5 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Space.lg,
    paddingTop: Space.lg,
    paddingBottom: Space.xs,
  },
  row: {
    minHeight: 64,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.sm, padding: Space.xxl },
  inlineLoading: { alignItems: 'center', paddingVertical: Space.lg },
  emptyText: { textAlign: 'center', maxWidth: 280 },
  pressed: { opacity: Motion.pressedOpacity },
  chooser: { flex: 1 },
  chooserHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.sm,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chooserTitle: { flex: 1, gap: 1, minWidth: 0 },
  chooserHint: { paddingHorizontal: Space.lg, paddingTop: Space.xs, paddingBottom: Space.sm },
  chooserList: { paddingBottom: Space.xxl },
  platformRow: {
    minHeight: 80,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  platformIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Left-aligned: a partial last row centred leaves a margin that reads as a
  // layout bug.
  platformBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Space.xs,
    marginTop: Space.xs,
  },
  startContent: { paddingBottom: Space.xxl },
  welcome: {
    alignItems: 'center',
    paddingHorizontal: Space.xxl,
    paddingTop: Space.lg,
    paddingBottom: Space.xl,
    gap: Space.xs,
  },
  welcomeIcon: {
    width: 52,
    height: 52,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },
  welcomeText: { textAlign: 'center', maxWidth: 275 },
  browseLines: {
    alignSelf: 'stretch',
    minHeight: 48,
    marginTop: Space.md,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  startSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Space.lg,
    paddingTop: Space.lg,
    paddingBottom: Space.xs,
  },
});
