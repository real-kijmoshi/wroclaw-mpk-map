import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import { getAlerts } from '@/lib/api';
import { orderAlertsForSelectedLines } from '@/lib/alert-order';
import { REFRESH_MS } from '@/lib/config';
import { formatAge } from '@/lib/format';
import { selectionStore, useSelectedLines } from '@/lib/selection';

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
      {alerts.loading && !alerts.data ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.five }]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={alerts.loading}
              onRefresh={alerts.refresh}
              tintColor={theme.textSecondary}
            />
          }>
          {alerts.error && !alerts.data ? (
            <View style={styles.state}>
              <Ionicons name="cloud-offline-outline" size={28} color={theme.textSecondary} />
              <ThemedText themeColor="textSecondary">Nie udało się pobrać utrudnień</ThemedText>
            </View>
          ) : !alerts.data?.alerts.length ? (
            <View style={styles.state}>
              <Ionicons name="checkmark-circle-outline" size={28} color={theme.success} />
              <ThemedText type="defaultSemiBold">Brak zgłoszonych utrudnień</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.stateNote}>
                Komunikaty pochodzą ze źródeł zewnętrznych i mogą pojawiać się z opóźnieniem.
              </ThemedText>
            </View>
          ) : (
            orderAlertsForSelectedLines(alerts.data.alerts, selectedLines).flatMap((section, i) => [
              section.heading ? (
                <ThemedText
                  key={`heading-${i}`}
                  type="small"
                  themeColor="textSecondary"
                  style={styles.sectionHeading}>
                  {section.heading}
                </ThemedText>
              ) : null,
              ...section.alerts.map((alert) => (
                <Pressable
                  key={alert.id}
                  onPress={() => open(alert.url)}
                  disabled={!alert.url}
                  accessibilityRole={alert.url ? 'link' : 'text'}
                  style={({ pressed }) => [pressed && alert.url ? styles.pressed : null]}>
                  <ThemedView type="backgroundElement" style={styles.card}>
                    <View style={styles.cardHeader}>
                      <ThemedText type="small" themeColor="textSecondary">
                        {formatAge(alert.timestamp)}
                      </ThemedText>
                      {!!alert.url && (
                        <Ionicons name="open-outline" size={15} color={theme.textSecondary} />
                      )}
                    </View>

                    {!!alert.title && <ThemedText type="defaultSemiBold">{alert.title}</ThemedText>}

                    {!!alert.content && alert.content !== alert.title && (
                      <ThemedText type="small" numberOfLines={6}>
                        {alert.content}
                      </ThemedText>
                    )}

                    {alert.affected.length > 0 && (
                      <View style={styles.affected}>
                        {alert.affected.map((line) => (
                          <Pressable
                            key={line}
                            accessibilityRole="button"
                            accessibilityLabel={`Pokaż na mapie linię ${line}`}
                            onPress={() => {
                              // Filter the map to that line and get out of the
                              // way, which is the only reason to tap a badge here.
                              selectionStore.set([line]);
                              router.back();
                            }}>
                            <LineBadge line={line} type={alert.types?.[line]} size="small" />
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </ThemedView>
                </Pressable>
              )),
            ])
          )}
        </ScrollView>
      )}
    </ModalScreen>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, gap: Spacing.two, paddingTop: Spacing.three },
  state: { alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.six },
  stateNote: { textAlign: 'center', paddingHorizontal: Spacing.four },
  card: { borderRadius: 18, padding: Spacing.three, gap: Spacing.two },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  affected: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one, paddingTop: Spacing.one },
  sectionHeading: { marginBottom: Spacing.one },
  pressed: { opacity: 0.7 },
});
