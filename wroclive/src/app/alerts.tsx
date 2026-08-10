import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Space } from '@/constants/design';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getAlerts, type Alert } from '@/lib/api';
import { orderAlertsForSelectedLines } from '@/lib/alert-order';
import { REFRESH_MS } from '@/lib/config';
import { formatAge } from '@/lib/format';
import { selectionStore, useSelectedLines } from '@/lib/selection';

/**
 * The source's own routing tags, stripped from the display text.
 *
 * `@AlertMPK` opens nearly every post with `#AlertMPK`, often followed by
 * `#TRAM` or `#BUS` — they are how the account files its posts, not information
 * for a rider, and they were the first thing on screen in every single card.
 * The permalink still opens the original, tags and all.
 */
const SOURCE_TAGS = /(^|\s)#(alertmpk|tram|trams|bus|buses|autobus|mpk|wroclaw|wrocław)\b/gi;

const clean = (text: string) => text.replace(SOURCE_TAGS, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * How serious the notice is, from the words it uses.
 *
 * Only enough to sort a restored service from an ongoing one, so the accent
 * stripe says at a glance which cards still matter. Anything unrecognised is
 * treated as a live disruption — under-reporting a disruption is the failure
 * that leaves someone at a stop.
 */
function severityOf(alert: Alert): 'resolved' | 'disruption' {
  const text = `${alert.title ?? ''} ${alert.content}`.toLowerCase();
  return /przywrócon|wznowion|zakończon|odwołane utrudnien/.test(text) ? 'resolved' : 'disruption';
}

/**
 * Service alerts, as scraped upstream.
 *
 * An empty list is a normal state, not a failure — it means nothing is being
 * reported right now — so it says exactly that rather than showing an error.
 */
export default function AlertsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const alerts = usePoll((signal) => getAlerts({ signal }), REFRESH_MS.alerts);
  const selectedLines = useSelectedLines();

  const open = async (url: string | null) => {
    if (!url) return;
    await WebBrowser.openBrowserAsync(url);
  };

  return (
    <ModalScreen
      title="Utrudnienia"
      subtitle={
        alerts.data?.lastRefreshAt ? `Sprawdzono ${formatAge(alerts.data.lastRefreshAt)}` : null
      }>
      {(scroll) =>
        alerts.loading && !alerts.data ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : (
          <Animated.ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
            showsVerticalScrollIndicator={false}
            onScroll={scroll.onScroll}
            scrollEventThrottle={scroll.scrollEventThrottle}
            refreshControl={
              <RefreshControl
                refreshing={alerts.loading}
                onRefresh={alerts.refresh}
                tintColor={theme.textSecondary}
              />
            }>
            {alerts.error && !alerts.data ? (
              <View style={styles.state}>
                <Ionicons name="cloud-offline-outline" size={30} color={theme.textTertiary} />
                <ThemedText themeColor="textSecondary">Nie udało się pobrać utrudnień</ThemedText>
              </View>
            ) : !alerts.data?.alerts.length ? (
              <View style={styles.state}>
                <Ionicons name="checkmark-circle" size={34} color={theme.success} />
                <ThemedText type="headline">Brak zgłoszonych utrudnień</ThemedText>
                <ThemedText type="footnote" themeColor="textSecondary" style={styles.stateNote}>
                  Komunikaty pochodzą ze źródeł zewnętrznych i mogą pojawiać się z opóźnieniem.
                </ThemedText>
              </View>
            ) : (
              orderAlertsForSelectedLines(alerts.data.alerts, selectedLines).map((section, index) => (
                <View key={section.heading ?? `section-${index}`} style={styles.section}>
                  {!!section.heading && (
                    <ThemedText
                      type="footnote"
                      weight="semibold"
                      themeColor="textSecondary"
                      style={styles.sectionHeading}>
                      {section.heading.toLocaleUpperCase('pl')}
                    </ThemedText>
                  )}

                  {section.alerts.map((alert) => (
                    <AlertCard
                      key={alert.id}
                      alert={alert}
                      onOpen={() => open(alert.url)}
                      onLine={(line) => {
                        // Filter the map to that line and get out of the way,
                        // which is the only reason to tap a badge here.
                        selectionStore.set([line]);
                        router.back();
                      }}
                    />
                  ))}
                </View>
              ))
            )}
          </Animated.ScrollView>
        )
      }
    </ModalScreen>
  );
}

function AlertCard({
  alert,
  onOpen,
  onLine,
}: {
  alert: Alert;
  onOpen: () => void;
  onLine: (line: string) => void;
}) {
  const theme = useTheme();
  const severity = severityOf(alert);
  const accent = severity === 'resolved' ? theme.success : theme.danger;

  const title = alert.title ? clean(alert.title) : '';
  const body = clean(alert.content);
  const showBody = !!body && body !== title;

  return (
    <Pressable
      onPress={onOpen}
      disabled={!alert.url}
      accessibilityRole={alert.url ? 'link' : 'text'}
      style={({ pressed }) => [pressed && alert.url ? styles.pressed : null]}>
      <View style={[styles.card, { backgroundColor: theme.backgroundCard }]}>
        {/* The one thing the eye should catch while scrolling: whether this is
            still happening. */}
        <View style={[styles.stripe, { backgroundColor: accent }]} />

        <View style={styles.cardBody}>
          <View style={styles.cardHeader}>
            <Ionicons
              name={severity === 'resolved' ? 'checkmark-circle' : 'alert-circle'}
              size={15}
              color={accent}
            />
            <ThemedText type="footnote" themeColor="textSecondary" style={styles.age}>
              {formatAge(alert.timestamp)}
            </ThemedText>
            {!!alert.url && (
              <Ionicons name="open-outline" size={15} color={theme.textTertiary} />
            )}
          </View>

          {!!title && <ThemedText type="headline">{title}</ThemedText>}

          {showBody && (
            <ThemedText type="callout" themeColor={title ? 'textSecondary' : 'text'} numberOfLines={6}>
              {body}
            </ThemedText>
          )}

          {alert.affected.length > 0 && (
            <View style={styles.affected}>
              {alert.affected.map((line) => (
                <Pressable
                  key={line}
                  accessibilityRole="button"
                  accessibilityLabel={`Pokaż na mapie linię ${line}`}
                  // The badge is 26pt by design; the target underneath it is
                  // not allowed to be.
                  hitSlop={9}
                  onPress={() => onLine(line)}>
                  <LineBadge line={line} type={alert.types?.[line]} size="small" />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.sm, gap: Space.xl },
  section: { gap: Space.sm },
  sectionHeading: { letterSpacing: 0.5, paddingHorizontal: Space.xs },
  state: { alignItems: 'center', gap: Space.sm, paddingVertical: Space.huge },
  stateNote: { textAlign: 'center', paddingHorizontal: Space.xl },
  card: { flexDirection: 'row', borderRadius: Radius.lg, overflow: 'hidden' },
  stripe: { width: 4 },
  cardBody: { flex: 1, padding: Space.lg, gap: Space.sm, minWidth: 0 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  age: { flex: 1 },
  // Left-aligned: a partial last row centred leaves a margin that reads as a
  // layout bug.
  affected: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, paddingTop: Space.xs },
  pressed: { opacity: 0.7 },
});
