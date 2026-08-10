import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Divider, LinkRow, Row, RowIcon, Section } from './list';
import { StopAreaRow } from './stop-area-row';
import { ThemedText } from './themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import type { Stop } from '@/lib/api';
import { formatDistance, plural } from '@/lib/format';
import type { StopArea } from '@/lib/stops-api';

export type LiveStatus = {
  text: string;
  freshness: string;
  tone: 'live' | 'stale' | 'loading' | 'error';
};

/**
 * The part of the sheet that is always on screen.
 *
 * Everything the old HUD card carried — the city, the vehicle count, the
 * freshness, search and settings — lives here instead, at the bottom of the
 * screen where a thumb reaches and where it stops covering the map.
 */
export function MapSheetHeader({
  status,
  onSearch,
  onSettings,
}: {
  status: LiveStatus;
  onSearch: () => void;
  onSettings: () => void;
}) {
  const theme = useTheme();
  const dotColor =
    status.tone === 'live'
      ? theme.success
      : status.tone === 'error'
        ? theme.danger
        : theme.textTertiary;

  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={onSearch}
          accessibilityRole="button"
          accessibilityLabel="Szukaj linii i przystanków"
          accessibilityHint="Otwiera wyszukiwanie"
          style={({ pressed }) => [
            styles.search,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="search" size={17} color={theme.textSecondary} />
          <ThemedText type="callout" themeColor="textSecondary" numberOfLines={1}>
            Szukaj linii lub przystanku
          </ThemedText>
        </Pressable>

        <Pressable
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel="Ustawienia"
          style={({ pressed }) => [
            styles.settings,
            { backgroundColor: theme.backgroundElement },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="settings-outline" size={19} color={theme.text} />
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.liveDot, { backgroundColor: dotColor }]} />
        <ThemedText type="footnote" weight="semibold" numberOfLines={1} style={styles.statusText}>
          {status.text}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary" numberOfLines={1}>
          {status.freshness}
        </ThemedText>
      </View>
    </View>
  );
}

export type MapSheetHomeProps = {
  selectedLineCount: number;
  alertCount: number | null;
  /** Places, not platforms — grouped by `groupStopAreas`. */
  nearbyAreas: StopArea[];
  /** Whether the rider's position is known, which is what makes the list mean anything. */
  located: boolean;
  locating: boolean;
  /** Why the last locate attempt produced nothing, if it produced nothing. */
  locateProblem: 'denied' | 'failed' | null;
  /** The fleet poll is failing — the map is showing the last thing it knew. */
  offline: boolean;
  onLines: () => void;
  onAlerts: () => void;
  onLocate: () => void;
  onRetry: () => void;
  onStop: (stop: Stop) => void;
};

/** How many places fit before the list stops being a glance and becomes a scroll. */
const NEARBY_LIMIT = 6;

/** What the sheet shows when nothing is selected. */
export function MapSheetHome({
  selectedLineCount,
  alertCount,
  nearbyAreas,
  located,
  locating,
  locateProblem,
  offline,
  onLines,
  onAlerts,
  onLocate,
  onRetry,
  onStop,
}: MapSheetHomeProps) {
  const theme = useTheme();

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      {/*
       * A dead connection is the one thing worth interrupting the layout for:
       * everything below it is the last thing the app knew, not what is
       * happening now, and the rider needs both facts and a way to act.
       */}
      {offline && (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Spróbuj połączyć ponownie"
          style={({ pressed }) => [
            styles.banner,
            { backgroundColor: theme.backgroundCard, borderColor: theme.danger },
            pressed && styles.pressed,
          ]}>
          <Ionicons name="cloud-offline" size={18} color={theme.danger} />
          <View style={styles.bannerText}>
            <ThemedText type="callout" weight="semibold">
              Brak połączenia
            </ThemedText>
            <ThemedText type="footnote" themeColor="textSecondary">
              Pokazujemy ostatnie znane pozycje.
            </ThemedText>
          </View>
          <ThemedText type="footnote" weight="semibold" color={theme.accent}>
            Ponów
          </ThemedText>
        </Pressable>
      )}

      {/*
       * Nearest first, because it is the only thing here a rider needs *now*.
       * The line filter and the alerts are settings you visit; where the next
       * tram goes from is the question you opened the app with.
       */}
      <Section
        title="Blisko Ciebie"
        footer={
          located && nearbyAreas.length > NEARBY_LIMIT
            ? `i ${nearbyAreas.length - NEARBY_LIMIT} ${plural(nearbyAreas.length - NEARBY_LIMIT, ['dalszy przystanek', 'dalsze przystanki', 'dalszych przystanków'])} na mapie`
            : undefined
        }>
        {locateProblem === 'denied' ? (
          // Nothing this button can do now lives inside the app, so it stops
          // pretending and points at the place that can.
          <LinkRow
            label="Brak dostępu do lokalizacji"
            hint="Włącz go w Ustawieniach systemu, aby zobaczyć przystanki wokół siebie"
            leading={<RowIcon name="locate" color={theme.danger} />}
            onPress={() => Linking.openSettings()}
          />
        ) : !located ? (
          <LinkRow
            label={locating ? 'Szukanie lokalizacji…' : 'Pokaż przystanki w pobliżu'}
            hint={
              locateProblem === 'failed'
                ? 'Nie udało się ustalić pozycji — spróbuj ponownie'
                : 'Przystanki na mapie działają bez lokalizacji — wystarczy przybliżyć'
            }
            leading={
              <RowIcon
                name="locate"
                color={locateProblem === 'failed' ? theme.danger : theme.accent}
              />
            }
            onPress={onLocate}
          />
        ) : nearbyAreas.length === 0 ? (
          <Row
            label="Brak przystanków w pobliżu"
            hint="Najbliższy jest dalej niż 700 m"
          />
        ) : (
          nearbyAreas.slice(0, NEARBY_LIMIT).map((area, index) => (
            <View key={area.primary.id}>
              {index > 0 && <Divider />}
              <StopAreaRow
                area={area}
                trailing={
                  formatDistance(area.distance) ? (
                    <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
                      {formatDistance(area.distance)}
                    </ThemedText>
                  ) : null
                }
                onPress={() => onStop(area.primary)}
              />
            </View>
          ))
        )}
      </Section>

      <Section>
        <LinkRow
          label="Linie"
          leading={<RowIcon name="git-branch" color={theme.textSecondary} />}
          value={
            selectedLineCount === 0
              ? 'Cała sieć'
              : `${selectedLineCount} ${plural(selectedLineCount, ['wybrana', 'wybrane', 'wybranych'])}`
          }
          onPress={onLines}
        />
        <Divider />
        <LinkRow
          label="Utrudnienia"
          leading={<RowIcon name="warning" color={alertCount ? theme.danger : theme.textSecondary} />}
          value={alertCount === null ? null : String(alertCount)}
          onPress={onAlerts}
        />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { gap: Space.sm, paddingBottom: Space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  search: {
    flex: 1,
    // minHeight, not height: at the larger Dynamic Type sizes the placeholder
    // has to be allowed to push the field taller rather than be clipped by it.
    minHeight: 44,
    paddingVertical: Space.sm,
    borderRadius: Radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.md,
  },
  settings: {
    width: 44,
    minHeight: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 20 },
  liveDot: { width: 7, height: 7, borderRadius: Radius.pill },
  statusText: { flex: 1, minWidth: 0 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    minHeight: 56,
  },
  bannerText: { flex: 1, gap: 1, minWidth: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.xs, paddingBottom: Space.xxl, gap: Space.xl },
  pressed: { opacity: Motion.pressedOpacity },
});
