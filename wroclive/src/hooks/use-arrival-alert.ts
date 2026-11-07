import { useCallback, useEffect, useRef } from 'react';
import { ActionSheetIOS, Alert, Linking, Platform } from 'react-native';

import { usePoll, type PollState } from '@/hooks/use-poll';
import { ApiError, getVehicle, vehiclePollDelay, type VehicleDetail } from '@/lib/api';
import { arrivalAlertStore, useArrivalAlert, type AlertKind } from '@/lib/arrival-alerts';
import { REFRESH_MS } from '@/lib/config';
import { failed, tapped } from '@/lib/haptics';

const followServer = () => vehiclePollDelay(REFRESH_MS.vehicles);
/** How long a tracked vehicle must stay unknown to the server before its alert ends. */
const MISSING_GRACE_MS = 90_000;

/**
 * A stop in a vehicle's list means one of two things, and only the rider
 * knows which: they are waiting there for this tram, or they are on it and
 * getting off there. Asked, not guessed — a phone position a few metres from a
 * tram cannot tell "on board" from "standing at the kerb beside it".
 */
function askKind(stopName: string): Promise<AlertKind | null> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) =>
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: stopName,
          options: ['Jadę tym pojazdem — wysiadam tutaj', 'Czekam tutaj na ten pojazd', 'Anuluj'],
          cancelButtonIndex: 2,
        },
        (index) => resolve(index === 0 ? 'trip' : index === 1 ? 'arrival' : null),
      ),
    );
  }
  if (Platform.OS === 'android') {
    return new Promise((resolve) => {
      let settled = false;
      const choose = (kind: AlertKind | null) => {
        if (settled) return;
        settled = true;
        resolve(kind);
      };
      Alert.alert(
        stopName,
        'Co chcesz śledzić?',
        [
          { text: 'Jadę — wysiadam tutaj', onPress: () => choose('trip') },
          { text: 'Czekam na ten pojazd', onPress: () => choose('arrival') },
          { text: 'Anuluj', style: 'cancel', onPress: () => choose(null) },
        ],
        { cancelable: true, onDismiss: () => choose(null) },
      );
    });
  }
  return Promise.resolve(null);
}

/**
 * The arrival alert and the trip, wired to the screen.
 *
 * The armed vehicle keeps being followed when its sheet is closed, so the
 * alert tracks the tram rather than the screen: while it is the open vehicle
 * the sheet's own detail poll feeds it, and otherwise a poll of its own does.
 */
export function useArrivalAlertTracking(detail: PollState<VehicleDetail>, openVehicleId: string | null) {
  const alert = useArrivalAlert();

  const own = usePoll(
    (signal) => getVehicle(alert?.vehicleId as string, { signal, retryWhileLoading: false }),
    REFRESH_MS.vehicles,
    {
      enabled: Boolean(alert) && alert?.phase !== 'completed' && alert?.vehicleId !== openVehicleId,
      key: alert?.vehicleId ?? '',
      delayMs: followServer,
    },
  );

  // A 404 is how the server says "not tracked", but it also says it to every
  // phone at once for a moment after a deploy (the fleet is empty until the
  // first poll) and once MPK's feed has been down past the server's stale
  // window. Ending the alert on the first one cancelled every rider's
  // notification in those cases, so the vehicle has to stay missing.
  const missingSince = useRef<number | null>(null);
  const missing = useCallback((error: Error | null) => {
    if (!(error instanceof ApiError) || error.status !== 404) return;
    const now = Date.now();
    missingSince.current ??= now;
    if (now - missingSince.current >= MISSING_GRACE_MS) {
      missingSince.current = null;
      void arrivalAlertStore.finish();
    }
  }, []);
  useEffect(() => {
    missingSince.current = null;
  }, [alert?.vehicleId]);

  useEffect(() => {
    if (!detail.data) return;
    if (detail.data.vehicle.id === alert?.vehicleId) missingSince.current = null;
    void arrivalAlertStore.follow(detail.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows each answer, not each alert edit
  }, [detail.data]);
  useEffect(() => {
    if (!own.data) return;
    missingSince.current = null;
    void arrivalAlertStore.follow(own.data);
  }, [own.data]);
  useEffect(() => {
    missing(own.error);
  }, [missing, own.error]);
  useEffect(() => {
    if (alert?.vehicleId === openVehicleId) missing(detail.error);
  }, [alert?.vehicleId, detail.error, missing, openVehicleId]);

  const toggle = useCallback(
    async (stop: { id: string; name: string }) => {
      tapped();
      const current = arrivalAlertStore.getSnapshot();
      const data = detail.data;
      if (current && current.stopId === stop.id && current.vehicleId === data?.vehicle.id) {
        await arrivalAlertStore.disarm();
        return;
      }
      if (!data) return;
      const kind = await askKind(stop.name);
      if (!kind) return;
      const result = await arrivalAlertStore.arm(
        {
          kind,
          vehicleId: data.vehicle.id,
          line: data.vehicle.line,
          towards: data.trip?.towards ?? data.trip?.headsign ?? null,
          stopId: stop.id,
          stopName: stop.name,
        },
        data,
      );
      if (result === 'denied') {
        failed();
        Alert.alert(
          'Powiadomienia są wyłączone',
          kind === 'trip'
            ? 'Włącz je w Ustawieniach systemu, aby dostać powiadomienie przed wysiadką.'
            : 'Włącz je w Ustawieniach systemu, aby dostać powiadomienie przed przyjazdem.',
          [
            { text: 'Anuluj', style: 'cancel' },
            { text: 'Ustawienia', onPress: () => Linking.openSettings() },
          ],
        );
      }
    },
    [detail.data],
  );

  /**
   * The armed vehicle's latest answer, from whichever poll is following it —
   * so the map can keep drawing it after its sheet is closed.
   */
  const tracked =
    alert && detail.data?.vehicle.id === alert.vehicleId
      ? detail.data
      : alert && own.data?.vehicle.id === alert.vehicleId
        ? own.data
        : null;

  return { alert, tracked, toggle, disarm: arrivalAlertStore.disarm };
}
