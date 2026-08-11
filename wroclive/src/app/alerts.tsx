import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LineBadge } from '@/components/line-badge';
import { Divider, LinkRow, RowIcon, Section } from '@/components/list';
import { ModalScreen } from '@/components/modal-screen';
import { ThemedText } from '@/components/themed-text';
import { HitTarget, Motion, Radius, Space } from '@/constants/design';
import { withAlpha } from '@/constants/theme';
import { usePoll } from '@/hooks/use-poll';
import { useTheme } from '@/hooks/use-theme';
import {
  ApiError,
  getAlerts,
  getIncidents,
  type Alert,
  type Alerts,
  type Incident,
  type IncidentsResponse,
} from '@/lib/api';
import { isResolvedAlert, orderAlertsForSelectedLines } from '@/lib/alert-order';
import { REFRESH_MS } from '@/lib/config';
import { formatAge, plural } from '@/lib/format';
import { tapped } from '@/lib/haptics';
import { orderIncidentsForSelectedLines } from '@/lib/incident-order';
import { selectionStore, useSelectedLines } from '@/lib/selection';

const SOURCE_TAGS = /(^|\s)#(alertmpk|tram|trams|bus|buses|autobus|mpk|wroclaw|wrocław)\b/gi;
const clean = (text: string) => text.replace(SOURCE_TAGS, ' ').replace(/\s{2,}/g, ' ').trim();

type Disruptions =
  | { kind: 'incidents'; data: IncidentsResponse }
  | { kind: 'alerts'; data: Alerts };

/** Old servers and malformed new responses keep the proven raw-alert screen available. */
async function getDisruptions(signal: AbortSignal): Promise<Disruptions> {
  try {
    return { kind: 'incidents', data: await getIncidents({ signal }) };
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 0)) throw error;
    return { kind: 'alerts', data: await getAlerts({ signal }) };
  }
}

export default function AlertsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const disruptions = usePoll(getDisruptions, REFRESH_MS.alerts);
  const selectedLines = useSelectedLines();
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // The list and detail intentionally share one scroller. Reset its retained
  // offset after either view is committed, otherwise a card opened low in the
  // list starts halfway through its timeline underneath the modal toolbar.
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [selectedIncident?.id]);

  const lastRefreshAt = disruptions.data?.data.lastRefreshAt;
  const showMap = (incident: Incident) => {
    if (!hasMapHint(incident)) return;
    tapped();
    // Hints contain names only. Until they can be resolved reliably, returning
    // to the existing map is the only honest handoff.
    router.back();
  };

  return (
    <ModalScreen
      title={selectedIncident ? 'Incydent' : 'Utrudnienia'}
      subtitle={lastRefreshAt ? `Sprawdzono ${formatAge(lastRefreshAt)}` : null}
      action={selectedIncident ? <BackAction onPress={() => setSelectedIncident(null)} /> : null}>
      {(scroll) =>
        disruptions.loading && !disruptions.data ? (
          <View style={styles.centered}>
            <ActivityIndicator />
            <ThemedText type="footnote" themeColor="textSecondary">
              Sprawdzamy utrudnienia…
            </ThemedText>
          </View>
        ) : (
          <Animated.ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Space.xxl }]}
            showsVerticalScrollIndicator={false}
            onScroll={scroll.onScroll}
            scrollEventThrottle={scroll.scrollEventThrottle}
            refreshControl={
              <RefreshControl
                refreshing={disruptions.loading}
                onRefresh={disruptions.refresh}
                tintColor={theme.textSecondary}
              />
            }>
            {!!disruptions.error && !!disruptions.data && <RefreshWarning />}
            {disruptions.error && !disruptions.data ? (
              <ErrorState />
            ) : selectedIncident ? (
              <IncidentDetail incident={selectedIncident} onShowMap={() => showMap(selectedIncident)} />
            ) : disruptions.data?.kind === 'alerts' ? (
              <RawAlerts
                alerts={disruptions.data.data.alerts}
                selectedLines={selectedLines}
                onLine={(line) => {
                  selectionStore.set([line]);
                  router.back();
                }}
              />
            ) : !disruptions.data?.data.incidents.length ? (
              <EmptyState />
            ) : (
              <View style={styles.incidentList}>
                <IncidentOverview incidents={disruptions.data.data.incidents} />
                {orderIncidentsForSelectedLines(
                  disruptions.data.data.incidents,
                  selectedLines,
                ).map((section, index) => (
                  <View key={section.heading ?? `section-${index}`} style={styles.section}>
                    <SectionHeading heading={section.heading} />
                    {section.incidents.map((incident) => (
                      <IncidentCard
                        key={incident.id}
                        incident={incident}
                        onPress={() => {
                          tapped();
                          setSelectedIncident(incident);
                        }}
                      />
                    ))}
                  </View>
                ))}
              </View>
            )}
          </Animated.ScrollView>
        )
      }
    </ModalScreen>
  );
}

function IncidentCard({ incident, onPress }: { incident: Incident; onPress: () => void }) {
  const theme = useTheme();
  const latest = incident.timeline.at(-1)?.timestamp ?? incident.lastUpdatedAt;
  const resolved = incident.status === 'resolved';
  const name = incidentName(incident);
  const title = clean(incident.title);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Szczegóły incydentu: ${incident.title}`}
      accessibilityHint="Otwiera oś czasu"
      style={({ pressed }) => [pressed && styles.pressed]}>
      <View
        style={[styles.card, resolved && styles.resolvedCard, { backgroundColor: theme.backgroundCard }]}>
        <View style={styles.cardTopline}>
          <StatusChip status={incident.status} />
          {!resolved && incident.severity === 'major' && (
            <Ionicons
              name="warning"
              size={14}
              color={theme.danger}
              accessibilityLabel="Poważne utrudnienie"
            />
          )}
          <ThemedText type="footnote" themeColor="textSecondary" style={styles.age}>
            {formatAge(latest)}
          </ThemedText>
          <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
        </View>

        <View style={styles.cardCopy}>
          <ThemedText type="headline" numberOfLines={2}>{name}</ThemedText>
          {!!incident.locationName && title !== name && (
            <ThemedText type="subhead" themeColor="textSecondary" numberOfLines={resolved ? 1 : 2}>
              {title}
            </ThemedText>
          )}
        </View>

        <AffectedLines incident={incident} />

        {!resolved && !!incident.summary && clean(incident.summary) !== title && (
          <ThemedText type="callout" themeColor="textSecondary" numberOfLines={3}>
            {clean(incident.summary)}
          </ThemedText>
        )}

        <View style={styles.cardFooter}>
          <Ionicons name="git-branch-outline" size={14} color={theme.textTertiary} />
          <ThemedText type="caption" themeColor="textSecondary">
            {incident.timeline.length} {plural(incident.timeline.length, ['wpis', 'wpisy', 'wpisów'])} na osi czasu
          </ThemedText>
        </View>
      </View>
    </Pressable>
  );
}

function IncidentDetail({ incident, onShowMap }: { incident: Incident; onShowMap: () => void }) {
  const theme = useTheme();
  const timeline = [...incident.timeline].sort((left, right) => left.timestamp - right.timestamp);

  return (
    <View style={styles.detail}>
      <View style={styles.detailHeader}>
        <View style={styles.detailHeading}>
          <ThemedText type="title">{incidentName(incident)}</ThemedText>
          {!!incident.locationName && incident.title !== incident.locationName && (
            <ThemedText type="subhead" themeColor="textSecondary">{clean(incident.title)}</ThemedText>
          )}
        </View>
        <View style={styles.detailStatus}>
          {incident.status !== 'resolved' && incident.severity === 'major' && (
            <Ionicons
              name="warning"
              size={14}
              color={theme.danger}
              accessibilityLabel="Poważne utrudnienie"
            />
          )}
          <StatusChip status={incident.status} />
        </View>
      </View>

      {incident.affected.length > 0 && (
        <View style={styles.affectedBlock}>
          <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
            DOTYCZY
          </ThemedText>
          <AffectedLines incident={incident} />
        </View>
      )}

      <Section title="Stan obecny">
        <View style={styles.summary}>
          <ThemedText type="body">{clean(incident.summary)}</ThemedText>
        </View>
      </Section>

      <Section title="Oś czasu">
        {timeline.length ? timeline.map((entry, index) => {
          const title = clean(entry.title);
          const detail = entry.detail ? clean(entry.detail) : null;
          return (
            <View key={entry.id}>
              {index > 0 && <Divider />}
              <View style={styles.timelineRow}>
                <View style={styles.timelineMeta}>
                  <View style={[
                    styles.timelineDot,
                    { backgroundColor: entry.kind === 'resolved' ? theme.success : theme.textTertiary },
                  ]} />
                  <ThemedText type="footnote" weight="semibold" themeColor="textSecondary">
                    {formatClock(entry.timestamp)}
                  </ThemedText>
                </View>
                <View style={styles.timelineCopy}>
                  <ThemedText type="caption" weight="semibold" themeColor="textSecondary">
                    {timelineKindLabel(entry.kind)}
                  </ThemedText>
                  <ThemedText type="body" weight={entry.kind === 'resolved' ? 'semibold' : 'regular'}>
                    {title}
                  </ThemedText>
                  {!!detail && detail !== title && (
                    <ThemedText type="footnote" themeColor="textSecondary">
                      {detail}
                    </ThemedText>
                  )}
                </View>
                {entry.kind === 'resolved' && (
                  <Ionicons name="checkmark-circle" size={18} color={theme.success} />
                )}
              </View>
            </View>
          );
        }) : (
          <View style={styles.summary}>
            <ThemedText type="footnote" themeColor="textSecondary">
              Brak szczegółowych aktualizacji
            </ThemedText>
          </View>
        )}
      </Section>

      {hasMapHint(incident) && (
        <Section>
          <LinkRow
            label="Wróć do mapy"
            hint={incident.locationName ? `Lokalizacja: ${incidentName(incident)}` : 'Zamknij szczegóły'}
            leading={<RowIcon name="map-outline" color={theme.accent} />}
            onPress={onShowMap}
          />
        </Section>
      )}
    </View>
  );
}

function StatusChip({ status }: { status: Incident['status'] }) {
  const theme = useTheme();
  const resolved = status === 'resolved';
  const active = status === 'active';
  const color = resolved ? theme.success : active ? theme.danger : theme.textSecondary;
  const label = resolved ? 'Przywrócono ruch' : active ? 'Aktywne' : 'Aktualizacja';

  return (
    <View
      style={[
        styles.statusChip,
        { backgroundColor: active || resolved ? withAlpha(color, 0.16) : theme.backgroundElement },
      ]}>
      <ThemedText type="caption" weight="semibold" style={{ color }}>{label}</ThemedText>
    </View>
  );
}

function IncidentOverview({ incidents }: { incidents: Incident[] }) {
  const theme = useTheme();
  const active = incidents.filter((incident) => incident.status !== 'resolved').length;
  const resolved = incidents.length - active;

  return (
    <View style={[styles.overview, { backgroundColor: theme.backgroundCard }]}>
      <View style={[
        styles.overviewIcon,
        { backgroundColor: withAlpha(active ? theme.danger : theme.success, 0.14) },
      ]}>
        <Ionicons
          name={active ? 'warning-outline' : 'checkmark-circle-outline'}
          size={22}
          color={active ? theme.danger : theme.success}
        />
      </View>
      <View style={styles.overviewCopy}>
        <ThemedText type="headline">
          {active
            ? `${active} ${plural(active, ['aktywne utrudnienie', 'aktywne utrudnienia', 'aktywnych utrudnień'])}`
            : 'Ruch bez aktywnych utrudnień'}
        </ThemedText>
        <ThemedText type="footnote" themeColor="textSecondary">
          {resolved
            ? `${resolved} ${plural(resolved, ['zakończone zdarzenie', 'zakończone zdarzenia', 'zakończonych zdarzeń'])} poniżej`
            : 'Lista odświeża się automatycznie'}
        </ThemedText>
      </View>
    </View>
  );
}

function AffectedLines({ incident }: { incident: Incident }) {
  if (!incident.affected.length) return null;
  return (
    <View style={styles.affected}>
      {incident.affected.map((line) => (
        <LineBadge key={line} line={line} type={incident.types[line]} size="small" />
      ))}
    </View>
  );
}

function RawAlerts({
  alerts,
  selectedLines,
  onLine,
}: {
  alerts: Alert[];
  selectedLines: readonly string[];
  onLine: (line: string) => void;
}) {
  if (!alerts.length) return <EmptyState />;
  return orderAlertsForSelectedLines(alerts, selectedLines).map((section, index) => (
    <View key={section.heading ?? `raw-section-${index}`} style={styles.section}>
      <SectionHeading heading={section.heading} />
      {section.alerts.map((alert) => (
        <RawAlertCard key={alert.id} alert={alert} onLine={onLine} />
      ))}
    </View>
  ));
}

function RawAlertCard({ alert, onLine }: { alert: Alert; onLine: (line: string) => void }) {
  const theme = useTheme();
  const resolved = isResolvedAlert(alert);
  const accent = resolved ? theme.success : theme.danger;
  const title = alert.title ? clean(alert.title) : '';
  const body = clean(alert.content);

  const open = async () => {
    if (alert.url) await WebBrowser.openBrowserAsync(alert.url);
  };

  return (
    <Pressable
      onPress={open}
      disabled={!alert.url}
      accessibilityRole={alert.url ? 'link' : 'text'}
      style={({ pressed }) => [pressed && alert.url ? styles.pressed : null]}>
      <View style={[styles.rawCard, { backgroundColor: theme.backgroundCard }]}>
        <View style={[styles.stripe, { backgroundColor: accent }]} />
        <View style={styles.rawCardBody}>
          <ThemedText type="footnote" themeColor="textSecondary">{formatAge(alert.timestamp)}</ThemedText>
          {!!title && <ThemedText type="headline">{title}</ThemedText>}
          {!!body && body !== title && (
            <ThemedText type="callout" themeColor={title ? 'textSecondary' : 'text'} numberOfLines={6}>
              {body}
            </ThemedText>
          )}
          <View style={styles.affected}>
            {alert.affected.map((line) => (
              <Pressable key={line} hitSlop={Space.sm} onPress={() => onLine(line)}>
                <LineBadge line={line} type={alert.types[line]} size="small" />
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function BackAction({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Wróć do listy"
      style={({ pressed }) => [styles.backAction, pressed && styles.pressed]}>
      <Ionicons name="chevron-back" size={18} color={theme.accent} />
      <ThemedText type="callout" weight="semibold" style={{ color: theme.accent }}>Lista</ThemedText>
    </Pressable>
  );
}

function SectionHeading({ heading }: { heading: string | null }) {
  if (!heading) return null;
  return (
    <ThemedText type="footnote" weight="semibold" themeColor="textSecondary" style={styles.sectionHeading}>
      {heading.toLocaleUpperCase('pl')}
    </ThemedText>
  );
}

function ErrorState() {
  const theme = useTheme();
  return (
    <View style={styles.state}>
      <Ionicons name="cloud-offline-outline" size={30} color={theme.textTertiary} />
      <ThemedText themeColor="textSecondary">Nie udało się pobrać utrudnień</ThemedText>
    </View>
  );
}

function RefreshWarning() {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.refreshWarning, { backgroundColor: theme.backgroundElement }]}>
      <Ionicons name="cloud-offline-outline" size={17} color={theme.textSecondary} />
      <ThemedText type="footnote" themeColor="textSecondary" style={styles.refreshWarningText}>
        Nie udało się odświeżyć. Pokazujemy ostatnie dostępne dane.
      </ThemedText>
    </View>
  );
}

function EmptyState() {
  const theme = useTheme();
  return (
    <View style={styles.state}>
      <Ionicons name="checkmark-circle" size={34} color={theme.success} />
      <ThemedText type="headline">Brak zgłoszonych utrudnień</ThemedText>
      <ThemedText type="footnote" themeColor="textSecondary" style={styles.stateNote}>
        Komunikaty pochodzą ze źródeł zewnętrznych i mogą pojawiać się z opóźnieniem.
      </ThemedText>
    </View>
  );
}

function hasMapHint(incident: Incident): boolean {
  return Boolean(
    incident.locationName ||
    incident.mapHints.stopNames.length ||
    incident.mapHints.streetNames.length ||
    incident.mapHints.areaNames.length,
  );
}

const clock = new Intl.DateTimeFormat('pl-PL', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Warsaw',
});

function formatClock(timestamp: number): string {
  return clock.format(new Date(timestamp));
}

function incidentName(incident: Incident): string {
  if (!incident.locationName) return clean(incident.title);
  return incident.locationName
    .split(/\s*\/\s*/)
    .map((part) => {
      const value = part.trim();
      if (!value) return value;
      if (value.length <= 3) return value.toLocaleUpperCase('pl-PL');
      return value[0].toLocaleUpperCase('pl-PL') + value.slice(1);
    })
    .join(' / ');
}

function timelineKindLabel(kind: Incident['timeline'][number]['kind']): string {
  switch (kind) {
    case 'diversion': return 'Objazd';
    case 'replacement_bus': return 'Komunikacja zastępcza';
    case 'update': return 'Aktualizacja';
    case 'resolved': return 'Ruch przywrócony';
    case 'reported': return 'Zgłoszenie';
    default: return 'Informacja';
  }
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.md },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingTop: Space.sm, gap: Space.xl },
  section: { gap: Space.sm },
  incidentList: { gap: Space.xl },
  sectionHeading: { letterSpacing: 0.5, paddingHorizontal: Space.xs },
  state: { alignItems: 'center', gap: Space.sm, paddingVertical: Space.huge },
  stateNote: { textAlign: 'center', paddingHorizontal: Space.xl },
  card: { borderRadius: Radius.lg, padding: Space.lg, gap: Space.md },
  resolvedCard: { paddingVertical: Space.md },
  cardTopline: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  cardCopy: { gap: Space.xs },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  age: { flex: 1, textAlign: 'right' },
  statusChip: {
    alignSelf: 'flex-start',
    borderRadius: Radius.pill,
    paddingHorizontal: Space.sm,
    paddingVertical: Space.xs,
  },
  affected: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs },
  overview: {
    borderRadius: Radius.lg,
    padding: Space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  overviewIcon: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overviewCopy: { flex: 1, gap: Space.xs, minWidth: 0 },
  detail: { gap: Space.xl },
  detailHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.md },
  detailHeading: { flex: 1, gap: Space.xs, minWidth: 0 },
  detailStatus: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  affectedBlock: { gap: Space.sm },
  summary: { paddingHorizontal: Space.lg, paddingVertical: Space.md },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
  },
  timelineMeta: { width: 58, gap: Space.xs, alignItems: 'flex-start' },
  timelineDot: { width: Space.sm, height: Space.sm, borderRadius: Radius.pill },
  timelineCopy: { flex: 1, gap: Space.xs, minWidth: 0 },
  rawCard: { flexDirection: 'row', borderRadius: Radius.lg, overflow: 'hidden' },
  stripe: { width: Space.xs },
  rawCardBody: { flex: 1, padding: Space.lg, gap: Space.sm, minWidth: 0 },
  backAction: {
    minHeight: HitTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  refreshWarning: {
    borderRadius: Radius.md,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  refreshWarningText: { flex: 1 },
  pressed: { opacity: Motion.pressedOpacity },
});
