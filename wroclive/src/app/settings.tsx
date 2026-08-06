import Ionicons from '@expo/vector-icons/Ionicons';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { liquidGlass } from '@/components/glass';
import { platformMapAvailable } from '@/components/map-view';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { apiGet } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { formatAge } from '@/lib/format';
import { preferencesStore, usePreferences, type MapProvider } from '@/lib/preferences';

type Health = {
  status: string;
  gtfs: { state: string; snapshot: string | null; builtAt: string | null };
  vehicles: { tracked: number; lastSuccessAt: string | null; lastError: string | null };
  alerts: { count: number; lastRefreshAt: string | null; lastError: string | null };
  lines: { total: number; trams: number; buses: number };
};

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
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.five }]}
        showsVerticalScrollIndicator={false}>
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

        <Section title="Na mapie">
          <Row
            label="Przystanki w pobliżu"
            hint="Po użyciu przycisku lokalizacji"
            control={
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
            control={
              <Switch
                value={preferences.followSelectedVehicle}
                onValueChange={(value) => preferencesStore.set('followSelectedVehicle', value)}
              />
            }
          />
        </Section>

        <Section title="Serwer">
          <Row
            label="Stan"
            hint={API_URL}
            control={
              <View style={styles.statusRow}>
                <View style={[styles.dot, { backgroundColor: serverState.color }]} />
                <ThemedText type="small" themeColor="textSecondary">
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
                control={
                  <ThemedText type="small" themeColor="textSecondary">
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
                control={
                  <ThemedText type="small" themeColor="textSecondary">
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
                control={
                  <ThemedText type="small" themeColor="textSecondary">
                    {health.data.alerts.count}
                  </ThemedText>
                }
              />
            </>
          )}
        </Section>

        <Section title="O aplikacji">
          <ThemedText type="small" themeColor="textSecondary" style={styles.about}>
            Pozycje pojazdów pochodzą z MPK Wrocław, rozkłady z otwartych danych miasta, a
            komunikaty ze źródeł zewnętrznych. Czasy przyjazdu są wyliczane z rozkładu i pozycji
            pojazdu — nie uwzględniają korków.
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.about}>
            {liquidGlass ? 'Interfejs: liquid glass' : 'Interfejs: rozmycie zastępcze'}
          </ThemedText>
        </Section>
      </ScrollView>
    </ModalScreen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionTitle}>
        {title}
      </ThemedText>
      <ThemedView type="backgroundElement" style={styles.card}>
        {children}
      </ThemedView>
    </View>
  );
}

function Row({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string | null;
  control?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <ThemedText>{label}</ThemedText>
        {!!hint && (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
            {hint}
          </ThemedText>
        )}
      </View>
      {control}
    </View>
  );
}

function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [pressed && styles.pressed]}>
      <Row
        label={label}
        hint={hint}
        control={
          selected ? <Ionicons name="checkmark" size={20} color={theme.text} /> : <View style={styles.spacer} />
        }
      />
    </Pressable>
  );
}

function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.separator }]} />;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.four },
  section: { gap: Spacing.two },
  sectionTitle: { textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: Spacing.one },
  card: { borderRadius: 18, paddingHorizontal: Spacing.three },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two + 2,
    minHeight: 52,
  },
  rowText: { flex: 1, gap: 1 },
  divider: { height: StyleSheet.hairlineWidth },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  dot: { width: 8, height: 8, borderRadius: 4 },
  spacer: { width: 20 },
  about: { paddingHorizontal: Spacing.one },
  pressed: { opacity: 0.6 },
});
