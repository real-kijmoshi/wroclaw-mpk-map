import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Constants from 'expo-constants';

import { liquidGlass } from '@/components/glass';
import { Choice, Divider, Row, Section } from '@/components/list';
import { platformMapAvailable } from '@/components/map-view';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Motion, Radius, Space } from '@/constants/design';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { apiGet } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { formatAge } from '@/lib/format';
import { preferencesStore, usePreferences, type AppleMapType, type ColorScheme, type MapProvider } from '@/lib/preferences';

type Health = {
  status: string;
  gtfs: { state: string; snapshot: string | null; builtAt: string | null };
  vehicles: { tracked: number; lastSuccessAt: string | null; lastError: string | null };
  alerts: { count: number; lastRefreshAt: string | null; lastError: string | null };
  lines: { total: number; trams: number; buses: number };
};

/**
 * Read from the manifest rather than hardcoded, so a released build always
 * reports the version someone can actually quote in a bug report.
 */
const APP_VERSION = Constants.expoConfig?.version ?? '—';
const APP_BUILD = `${Constants.expoConfig?.slug ?? 'wroclive'} · ${Platform.OS}`;

const MAP_TYPES: { id: AppleMapType; label: string }[] = [
  { id: 'standard', label: 'Mapa' },
  { id: 'hybrid', label: 'Hybrydowa' },
  { id: 'satellite', label: 'Satelita' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const preferences = usePreferences();

  // Rechecked while the screen is open, so "is the server up?" is answerable
  // without leaving the app.
  const health = usePoll((signal) => apiGet<Health>('/health', { signal }), 30_000);

  const serverState = health.error
    ? { text: 'Brak połączenia', color: theme.danger }
    : health.data?.status === 'ok'
      ? { text: 'Połączono', color: theme.success }
      : { text: 'Wczytywanie rozkładu…', color: theme.textSecondary };

  return (
    <ModalScreen title="Ustawienia">
      {(scroll) => (
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
          showsVerticalScrollIndicator={false}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}>
          {platformMapAvailable && (
            <Section title="Mapa">
              <Choice
                label="Mapa systemowa"
                hint={Platform.OS === 'ios' ? 'Apple Maps' : 'Mapa platformy'}
                selected={preferences.mapProvider === 'auto'}
                onPress={() => preferencesStore.set('mapProvider', 'auto' satisfies MapProvider)}
              />
              <Divider />
              <Choice
                label="OpenStreetMap"
                hint="Ta sama mapa na każdej platformie"
                selected={preferences.mapProvider === 'osm'}
                onPress={() => preferencesStore.set('mapProvider', 'osm' satisfies MapProvider)}
              />
            </Section>
          )}

          {/* Three mutually exclusive base styles are a segmented control, not
              three rows of a list — and the same choice is a tap away on the
              map itself, from the layers button. */}
          {Platform.OS === 'ios' && preferences.mapProvider === 'auto' && (
            <View style={styles.segmentSection}>
              <ThemedText
                type="footnote"
                weight="semibold"
                themeColor="textSecondary"
                style={styles.segmentTitle}>
                TYP MAPY
              </ThemedText>
              <View style={[styles.segment, { backgroundColor: theme.backgroundElement }]}>
                {MAP_TYPES.map((entry) => {
                  const active = preferences.appleMapType === entry.id;
                  return (
                    <Pressable
                      key={entry.id}
                      onPress={() => preferencesStore.set('appleMapType', entry.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        styles.segmentItem,
                        active && { backgroundColor: theme.backgroundCard },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText
                        type="footnote"
                        weight={active ? 'semibold' : 'medium'}
                        themeColor={active ? 'text' : 'textSecondary'}>
                        {entry.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <Section title="Na mapie">
            <Row
              label="Przystanki"
              hint="Pokazuj przystanki po przybliżeniu mapy"
              accessory={
                <Switch
                  value={preferences.showNearbyStops}
                  onValueChange={(value) => preferencesStore.set('showNearbyStops', value)}
                />
              }
            />
            <Divider />
            <Row
              label="Podążaj za pojazdem"
              hint="Przy wyborze utrzymuj pojazd na środku mapy"
              accessory={
                <Switch
                  value={preferences.followSelectedVehicle}
                  onValueChange={(value) => preferencesStore.set('followSelectedVehicle', value)}
                />
              }
            />
          </Section>

          <Section title="Motyw">
            <Choice
              label="Jasny"
              selected={preferences.colorScheme === 'light'}
              onPress={() => preferencesStore.set('colorScheme', 'light' satisfies ColorScheme)}
            />
            <Divider />
            <Choice
              label="Ciemny"
              selected={preferences.colorScheme === 'dark'}
              onPress={() => preferencesStore.set('colorScheme', 'dark' satisfies ColorScheme)}
            />
            <Divider />
            <Choice
              label="System"
              hint="Podążaj za ustawieniami telefonu"
              selected={preferences.colorScheme === 'system'}
              onPress={() => preferencesStore.set('colorScheme', 'system' satisfies ColorScheme)}
            />
          </Section>

          <Section title="Serwer" footer={API_URL}>
            <Row
              label="Stan"
              accessory={
                <View style={styles.statusRow}>
                  <View style={[styles.dot, { backgroundColor: serverState.color }]} />
                  <ThemedText
                    type="footnote"
                    themeColor="textSecondary"
                    numberOfLines={1}
                    style={styles.statusText}>
                    {serverState.text}
                  </ThemedText>
                </View>
              }
            />
            {!!health.data && (
              <>
                <Divider />
                <Row
                  label="Rozkład"
                  hint={health.data.gtfs.snapshot ?? health.data.gtfs.state}
                  accessory={
                    <ThemedText type="footnote" themeColor="textSecondary">
                      {health.data.lines.total} linii
                    </ThemedText>
                  }
                />
                <Divider />
                <Row
                  label="Pojazdy"
                  hint={
                    health.data.vehicles.lastSuccessAt
                      ? `Odczyt ${formatAge(health.data.vehicles.lastSuccessAt)}`
                      : (health.data.vehicles.lastError ?? 'Brak odczytu')
                  }
                  accessory={
                    <ThemedText type="footnote" themeColor="textSecondary">
                      {health.data.vehicles.tracked}
                    </ThemedText>
                  }
                />
                <Divider />
                <Row
                  label="Utrudnienia"
                  hint={
                    health.data.alerts.lastRefreshAt
                      ? `Sprawdzono ${formatAge(health.data.alerts.lastRefreshAt)}`
                      : (health.data.alerts.lastError ?? 'Brak danych')
                  }
                  accessory={
                    <ThemedText type="footnote" themeColor="textSecondary">
                      {health.data.alerts.count}
                    </ThemedText>
                  }
                />
              </>
            )}
          </Section>

          <Section title="O aplikacji" footer={APP_BUILD}>
            <Row
              label="Wersja"
              accessory={
                <ThemedText type="footnote" themeColor="textSecondary">
                  {APP_VERSION}
                </ThemedText>
              }
            />
            <Divider />
            <Row
              label="Interfejs"
              accessory={
                <ThemedText type="footnote" themeColor="textSecondary">
                  {liquidGlass ? 'Liquid glass' : 'Rozmycie zastępcze'}
                </ThemedText>
              }
            />
          </Section>

          <View style={styles.about}>
            <ThemedText type="footnote" themeColor="textSecondary">
              Pozycje pojazdów pochodzą z MPK Wrocław, rozkłady z otwartych danych miasta, a
              komunikaty ze źródeł zewnętrznych. Czasy przyjazdu są wyliczane z rozkładu i pozycji
              pojazdu — nie uwzględniają korków.
            </ThemedText>
          </View>
        </Animated.ScrollView>
      )}
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.sm, gap: Space.xl },
  segmentSection: { gap: Space.sm },
  segmentTitle: { letterSpacing: 0.5, paddingHorizontal: Space.lg },
  segment: { flexDirection: 'row', borderRadius: Radius.sm, padding: 2, gap: 2 },
  segmentItem: {
    flex: 1,
    minHeight: 34,
    borderRadius: Radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, flexShrink: 1 },
  statusText: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: Radius.pill },
  about: { paddingHorizontal: Space.lg, gap: Space.sm },
  pressed: { opacity: Motion.pressedOpacity },
});
