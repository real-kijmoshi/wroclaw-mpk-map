import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Constants from 'expo-constants';

import { liquidGlass } from '@/components/glass';
import { Choice, Divider, LinkRow, Row, RowIcon, Section } from '@/components/list';
import { platformMapAvailable } from '@/components/map-view';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Motion, Radius, Space } from '@/constants/design';
import { useTheme } from '@/hooks/use-theme';
import { usePoll } from '@/hooks/use-poll';
import { apiGet } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { formatAge, formatUptime } from '@/lib/format';
import { tapped } from '@/lib/haptics';
import {
  preferencesStore,
  usePreferences,
  type AppleMapType,
  type ColorScheme,
  type LayoutMode,
  type MapProvider,
  type MarkerStyle,
} from '@/lib/preferences';
import { withAlpha } from '@/constants/theme';

type Health = {
  status: string;
  uptimeSeconds?: number;
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

type IconName = keyof typeof Ionicons.glyphMap;

const THEME_OPTIONS: { id: ColorScheme; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Jasny', icon: 'sunny-outline' },
  { id: 'dark', label: 'Ciemny', icon: 'moon-outline' },
  { id: 'system', label: 'System', icon: 'phone-portrait-outline' },
];

const MAP_TYPES: { id: AppleMapType; label: string; icon: IconName }[] = [
  { id: 'standard', label: 'Mapa', icon: 'map-outline' },
  { id: 'hybrid', label: 'Hybrydowa', icon: 'layers-outline' },
  { id: 'satellite', label: 'Satelita', icon: 'planet-outline' },
];

const LEGAL_BASE_URL = 'https://wroclive.kijmoshi.xyz';

/**
 * A tiny screen outline with the chrome arrangement drawn inside.
 *
 * The sheet preview shows the bottom card; the classic preview shows a top
 * bar and side buttons — just enough to tell them apart at a glance.
 */
function LayoutPreview({ mode }: { mode: LayoutMode }) {
  const theme = useTheme();
  const ink = theme.textTertiary;
  const tint = withAlpha(theme.textTertiary, 0.14);

  return (
    <View style={[styles.previewBox, { backgroundColor: tint }]}>
      <View style={[styles.previewScreen, { borderColor: ink }]}>
        {mode === 'sheet' ? (
          <View style={[styles.previewSheet, { backgroundColor: ink }]} />
        ) : (
          <>
            <View style={[styles.previewTopBar, { backgroundColor: ink }]} />
            <View style={styles.previewSideDots}>
              <View style={[styles.previewDot, { backgroundColor: ink }]} />
              <View style={[styles.previewDot, { backgroundColor: ink }]} />
              <View style={[styles.previewDot, { backgroundColor: ink }]} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

/**
 * A tiny marker shape.
 *
 * The modern preview is the badge silhouette; the classic one is the tile.
 */
function MarkerPreview({ style: markerStyle }: { style: MarkerStyle }) {
  const theme = useTheme();
  const ink = theme.textTertiary;
  const tint = withAlpha(theme.textTertiary, 0.14);

  return (
    <View style={[styles.previewBox, { backgroundColor: tint }]}>
      {markerStyle === 'modern' ? (
        <View style={[styles.previewBadge, { backgroundColor: ink }]} />
      ) : (
        <View style={[styles.previewTile, { borderColor: ink }]} />
      )}
    </View>
  );
}

/**
 * A large picker option: preview on top, label and hint underneath.
 *
 * Replaces the plain radio row for choices worth *showing* rather than just
 * naming — the same pattern the platform's own wallpaper and appearance
 * pickers use, and a better fit than a list once the option already carries
 * a preview.
 */
function PickerCard({
  label,
  hint,
  preview,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  preview: ReactNode;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => {
        tapped();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.pickerCard,
        {
          backgroundColor: theme.backgroundCard,
          borderColor: selected ? theme.accent : theme.separator,
        },
        pressed && styles.pressed,
      ]}>
      {selected && (
        <View style={[styles.pickerCheck, { backgroundColor: theme.backgroundCard }]}>
          <Ionicons name="checkmark-circle" size={18} color={theme.accent} />
        </View>
      )}
      {preview}
      <ThemedText type="callout" weight="semibold" numberOfLines={1}>
        {label}
      </ThemedText>
      {!!hint && (
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={2}>
          {hint}
        </ThemedText>
      )}
    </Pressable>
  );
}

/**
 * A segmented control: one row of equally-weighted, mutually exclusive
 * options. Used wherever three-or-fewer choices do not need a preview of
 * their own — the theme and the Apple Maps base style.
 */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (id: T) => void;
  options: { id: T; label: string; icon?: IconName }[];
}) {
  const theme = useTheme();

  return (
    <View style={[styles.segmentContainer, { backgroundColor: theme.backgroundElement }]}>
      {options.map((option) => {
        const active = value === option.id;
        return (
          <Pressable
            key={option.id}
            onPress={() => {
              tapped();
              onChange(option.id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.segmentItem,
              active && { backgroundColor: theme.backgroundSelected },
              pressed && styles.pressed,
            ]}>
            {!!option.icon && (
              <Ionicons
                name={option.icon}
                size={14}
                color={active ? theme.text : theme.textSecondary}
              />
            )}
            <ThemedText
              type="footnote"
              weight={active ? 'semibold' : 'medium'}
              themeColor={active ? 'text' : 'textSecondary'}
              numberOfLines={1}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One number in the server's status grid: an icon, a value, and what it means. */
function StatTile({
  icon,
  tint,
  value,
  label,
  hint,
}: {
  icon: IconName;
  tint: string;
  value: string | number;
  label: string;
  hint?: string | null;
}) {
  return (
    <View style={styles.statTile}>
      <View style={[styles.statIcon, { backgroundColor: withAlpha(tint, 0.16) }]}>
        <Ionicons name={icon} size={14} color={tint} />
      </View>
      <ThemedText type="headline" weight="bold" numberOfLines={1}>
        {value}
      </ThemedText>
      <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
        {label}
      </ThemedText>
      {!!hint && (
        <ThemedText type="caption" themeColor="textTertiary" numberOfLines={1}>
          {hint}
        </ThemedText>
      )}
    </View>
  );
}

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
    <ModalScreen title="Ustawienia" subtitle="Dopasuj mapę do swojej trasy">
      {(scroll) => (
        <Animated.ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
          showsVerticalScrollIndicator={false}
          onScroll={scroll.onScroll}
          scrollEventThrottle={scroll.scrollEventThrottle}>
          <SettingsIntro
            layout={preferences.layout}
            markerStyle={preferences.markerStyle}
            colorScheme={preferences.colorScheme}
          />

          {/* First, because it is the one setting that changes what every other
              screen in the app looks like. A visual choice deserves a visual
              picker rather than a line of text describing it. */}
          <Section
            title="Układ"
            icon="layers-outline"
            plain
            footer="Klasyczny to układ sprzed przebudowy: pasek u góry, przyciski przy krawędzi, panel tylko dla wybranego pojazdu lub przystanku.">
            <View style={styles.pickerRow}>
              <PickerCard
                label="Panel"
                hint="Wyszukiwarka i przystanki zawsze pod ręką"
                preview={<LayoutPreview mode="sheet" />}
                selected={preferences.layout === 'sheet'}
                onPress={() => preferencesStore.set('layout', 'sheet' satisfies LayoutMode)}
              />
              <PickerCard
                label="Klasyczny"
                hint="Więcej widocznej mapy"
                preview={<LayoutPreview mode="classic" />}
                selected={preferences.layout === 'classic'}
                onPress={() => preferencesStore.set('layout', 'classic' satisfies LayoutMode)}
              />
            </View>
          </Section>

          {/* Next to the layout, because it is the same kind of choice: the
              same map and the same data, drawn the way it used to be. */}
          <Section
            title="Znaczniki pojazdów"
            icon="ellipse-outline"
            plain
            footer="Klasyczne to kafelki sprzed przebudowy: większe, z osobną strzałką kierunku, i pozostają kafelkami także po oddaleniu mapy. Nowe zamieniają się wtedy w kropki, dzięki czemu widać, gdzie jest gęsto.">
            <View style={styles.pickerRow}>
              <PickerCard
                label="Nowe"
                hint="Numer linii ze strzałką w jednym kształcie"
                preview={<MarkerPreview style="modern" />}
                selected={preferences.markerStyle === 'modern'}
                onPress={() => preferencesStore.set('markerStyle', 'modern' satisfies MarkerStyle)}
              />
              <PickerCard
                label="Klasyczne"
                hint="Większy kafelek i strzałka obok niego"
                preview={<MarkerPreview style="classic" />}
                selected={preferences.markerStyle === 'classic'}
                onPress={() => preferencesStore.set('markerStyle', 'classic' satisfies MarkerStyle)}
              />
            </View>
          </Section>

          {platformMapAvailable && (
            <Section title="Mapa" icon="navigate-outline">
              <Choice
                label="Mapa systemowa"
                hint={Platform.OS === 'ios' ? 'Apple Maps' : 'Mapa platformy'}
                leading={<RowIcon name="navigate-outline" color={theme.textTertiary} />}
                selected={preferences.mapProvider === 'auto'}
                onPress={() => preferencesStore.set('mapProvider', 'auto' satisfies MapProvider)}
              />
              <Divider />
              <Choice
                label="OpenStreetMap"
                hint="Ta sama mapa na każdej platformie"
                leading={<RowIcon name="globe-outline" color={theme.textTertiary} />}
                selected={preferences.mapProvider === 'osm'}
                onPress={() => preferencesStore.set('mapProvider', 'osm' satisfies MapProvider)}
              />
              {/* Three mutually exclusive base styles are a segmented control, not
                  three rows of a list — and the same choice is a tap away on the
                  map itself, from the layers button. */}
              {Platform.OS === 'ios' && preferences.mapProvider === 'auto' && (
                <>
                  <Divider />
                  <View style={styles.segmentWrap}>
                    <ThemedText
                      type="footnote"
                      weight="semibold"
                      themeColor="textSecondary"
                      style={styles.segmentLabel}>
                      TYP MAPY
                    </ThemedText>
                    <Segmented
                      value={preferences.appleMapType}
                      onChange={(id) => preferencesStore.set('appleMapType', id)}
                      options={MAP_TYPES}
                    />
                  </View>
                </>
              )}
            </Section>
          )}

          <Section title="Na mapie" icon="eye-outline">
            <Row
              label="Przystanki"
              hint="Pokazuj przystanki po przybliżeniu mapy"
              leading={<RowIcon name="eye-outline" color={theme.textTertiary} />}
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
              leading={<RowIcon name="locate-outline" color={theme.textTertiary} />}
              accessory={
                <Switch
                  value={preferences.followSelectedVehicle}
                  onValueChange={(value) => preferencesStore.set('followSelectedVehicle', value)}
                />
              }
            />
          </Section>

          <Section title="Motyw" icon="sunny-outline">
            <View style={styles.segmentCardWrap}>
              <Segmented
                value={preferences.colorScheme}
                onChange={(id) => preferencesStore.set('colorScheme', id)}
                options={THEME_OPTIONS}
              />
            </View>
          </Section>

          <Section title="Serwer" icon="cloud-outline" footer={API_URL}>
            <Row
              label="Stan"
              hint={serverState.text}
              leading={
                <View style={[styles.statusBadge, { backgroundColor: withAlpha(serverState.color, 0.16) }]}>
                  <View style={[styles.dot, { backgroundColor: serverState.color }]} />
                </View>
              }
            />
            {!!health.data && (
              <>
                <Divider />
                <View style={styles.statGrid}>
                  <StatTile
                    icon="calendar-outline"
                    tint={theme.accent}
                    value={health.data.lines.total}
                    label="linii w rozkładzie"
                    hint={health.data.gtfs.snapshot ?? health.data.gtfs.state}
                  />
                  <StatTile
                    icon="car-outline"
                    tint={theme.success}
                    value={health.data.vehicles.tracked}
                    label="pojazdów na mapie"
                    hint={
                      health.data.vehicles.lastSuccessAt
                        ? `Odczyt ${formatAge(health.data.vehicles.lastSuccessAt)}`
                        : (health.data.vehicles.lastError ?? 'Brak odczytu')
                    }
                  />
                  <StatTile
                    icon="warning-outline"
                    tint={health.data.alerts.count > 0 ? theme.danger : theme.textTertiary}
                    value={health.data.alerts.count}
                    label="utrudnień"
                    hint={
                      health.data.alerts.lastRefreshAt
                        ? `Sprawdzono ${formatAge(health.data.alerts.lastRefreshAt)}`
                        : (health.data.alerts.lastError ?? 'Brak danych')
                    }
                  />
                  <StatTile
                    icon="time-outline"
                    tint={theme.textTertiary}
                    value={formatUptime(health.data.uptimeSeconds) ?? '—'}
                    label="czas pracy"
                  />
                </View>
              </>
            )}
          </Section>

          <Section title="O aplikacji" icon="information-circle-outline" footer={APP_BUILD}>
            <Row
              label="Wersja"
              leading={<RowIcon name="information-circle-outline" color={theme.textTertiary} />}
              accessory={
                <ThemedText type="footnote" themeColor="textSecondary">
                  {APP_VERSION}
                </ThemedText>
              }
            />
            <Divider />
            <Row
              label="Interfejs"
              leading={<RowIcon name="eyedrop-outline" color={theme.textTertiary} />}
              accessory={
                <ThemedText type="footnote" themeColor="textSecondary">
                  {liquidGlass ? 'Liquid glass' : 'Rozmycie zastępcze'}
                </ThemedText>
              }
            />
          </Section>

          <Section title="Prawne" icon="document-text-outline" footer="Otwiera pełny tekst w przeglądarce.">
            <LinkRow
              label="Polityka prywatności"
              hint="Jakie dane są zbierane, gdzie trafiają i na jak długo"
              leading={<RowIcon name="shield-checkmark-outline" color={theme.textTertiary} />}
              value="/privacy"
              onPress={() => Linking.openURL(`${LEGAL_BASE_URL}/privacy`)}
            />
            <Divider />
            <LinkRow
              label="Warunki korzystania"
              hint="Zasady używania aplikacji i odpowiedzialność"
              leading={<RowIcon name="document-outline" color={theme.textTertiary} />}
              value="/terms"
              onPress={() => Linking.openURL(`${LEGAL_BASE_URL}/terms`)}
            />
            <Divider />
            <LinkRow
              label="Licencja"
              hint="Kod źródłowy i licencja MIT"
              leading={<RowIcon name="code-slash-outline" color={theme.textTertiary} />}
              value="GitHub"
              onPress={() =>
                Linking.openURL('https://github.com/real-kijmoshi/wroclaw-mpk-map/blob/main/LICENSE')
              }
            />
          </Section>

          <View style={styles.credit}>
            <ThemedText type="footnote" themeColor="textSecondary">
              Pozycje pojazdów pochodzą z MPK Wrocław i kłosok.pl. Rozkłady jazdy pochodzą z plików GTFS MPK Wrocław. Aplikacja jest open source i dostępna na{' '}
              <ThemedText
                type="footnote"
                weight="semibold"
                onPress={() => Linking.openURL('https://github.com/real-kijmoshi/wroclaw-mpk-map')}
              >
                GitHub
              </ThemedText>
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

  /* Picker cards — the visual replacement for a radio list, used where the
     option already carries a preview (layout, marker style). */
  pickerRow: { flexDirection: 'row', gap: Space.sm },
  pickerCard: {
    flex: 1,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    padding: Space.md,
    gap: Space.xs,
    alignItems: 'flex-start',
  },
  pickerCheck: {
    position: 'absolute',
    top: Space.sm,
    right: Space.sm,
    padding: 2,
    borderRadius: Radius.pill,
    zIndex: 1,
  },

  /* Previews — the visual centrepiece of a picker card. */
  previewBox: {
    width: '100%',
    height: 64,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewScreen: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  previewSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 18,
    borderTopLeftRadius: Radius.xs,
    borderTopRightRadius: Radius.xs,
  },
  previewTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
  },
  previewSideDots: {
    position: 'absolute',
    right: 6,
    top: 10,
    gap: 3,
  },
  previewDot: {
    width: 4,
    height: 4,
    borderRadius: Radius.pill,
  },
  previewBadge: {
    width: 26,
    height: 16,
    borderRadius: 5,
  },
  previewTile: {
    width: 30,
    height: 30,
    borderRadius: Radius.xs,
    borderWidth: 1.5,
  },

  /* Segmented control — the theme picker and the Apple Maps base style. */
  segmentWrap: { gap: Space.sm, paddingHorizontal: Space.lg, paddingVertical: Space.md },
  segmentCardWrap: { padding: Space.md },
  segmentLabel: { letterSpacing: 0.5 },
  segmentContainer: {
    flexDirection: 'row',
    borderRadius: Radius.lg,
    padding: Space.xs,
    gap: Space.xs,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    minHeight: 36,
    borderRadius: Radius.sm,
  },

  /* Status dot — tinted badge, same box as every other leading element. */
  statusBadge: {
    width: 30,
    height: 30,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: Radius.pill },

  /* Server status grid — one tile per number, instead of a list of rows. */
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
    padding: Space.md,
  },
  statTile: {
    flexBasis: '46%',
    flexGrow: 1,
    gap: 2,
  },
  statIcon: {
    width: 26,
    height: 26,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.xs,
  },

  /* Footer credit. */
  credit: { paddingHorizontal: Space.lg, gap: Space.sm },

  introCard: {
    borderRadius: Radius.xl,
    padding: Space.lg,
    gap: Space.lg,
  },
  introTop: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
  introMark: {
    width: 46,
    height: 46,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-8deg' }],
  },
  introMarkLine: { width: 25, height: 5, borderRadius: Radius.pill },
  introMarkDot: { width: 7, height: 7, borderRadius: Radius.pill, marginTop: Space.xs },
  introCopy: { flex: 1, gap: Space.xs },
  introRule: { height: StyleSheet.hairlineWidth },
  summaryRow: { flexDirection: 'row', gap: Space.md },
  summaryItem: { flex: 1, minWidth: 0, gap: Space.xs },

  pressed: { opacity: Motion.pressedOpacity },
});

function SettingsIntro({
  layout,
  markerStyle,
  colorScheme,
}: {
  layout: LayoutMode;
  markerStyle: MarkerStyle;
  colorScheme: ColorScheme;
}) {
  const theme = useTheme();

  const themeLabel = colorScheme === 'system' ? 'Systemowy' : colorScheme === 'dark' ? 'Ciemny' : 'Jasny';
  const layoutLabel = layout === 'sheet' ? 'Panel' : 'Klasyczny';
  const markerLabel = markerStyle === 'modern' ? 'Nowe znaczniki' : 'Klasyczne znaczniki';

  return (
    <View style={[styles.introCard, { backgroundColor: theme.backgroundCard }, Elevation.card]}>
      <View style={styles.introTop}>
        <View style={[styles.introMark, { backgroundColor: theme.accent }]}>
          <View style={[styles.introMarkLine, { backgroundColor: theme.backgroundCard }]} />
          <View style={[styles.introMarkDot, { backgroundColor: theme.backgroundCard }]} />
        </View>
        <View style={styles.introCopy}>
          <ThemedText type="title" weight="bold">Wroclive po Twojemu</ThemedText>
          <ThemedText type="subhead" themeColor="textSecondary">
            Zmień sposób wyświetlania mapy. Dane i ulubione trasy pozostają bez zmian.
          </ThemedText>
        </View>
      </View>
      <View style={[styles.introRule, { backgroundColor: theme.separator }]} />
      <View style={styles.summaryRow}>
        <View style={styles.summaryItem}>
          <ThemedText type="caption" themeColor="textSecondary">UKŁAD</ThemedText>
          <ThemedText type="callout" weight="semibold">{layoutLabel}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="caption" themeColor="textSecondary">POJAZDY</ThemedText>
          <ThemedText type="callout" weight="semibold">{markerLabel}</ThemedText>
        </View>
        <View style={styles.summaryItem}>
          <ThemedText type="caption" themeColor="textSecondary">MOTYW</ThemedText>
          <ThemedText type="callout" weight="semibold">{themeLabel}</ThemedText>
        </View>
      </View>
    </View>
  );
}
