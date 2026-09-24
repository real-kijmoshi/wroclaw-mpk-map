import { useCallback, useEffect } from 'react';
import { ActionSheetIOS, Alert, Linking, Platform } from 'react-native';

import { usePoll, type PollState } from '@/hooks/use-poll';
import { ApiError, getVehicle, vehiclePollDelay, type VehicleDetail } from '@/lib/api';
import { arrivalAlertStore, useArrivalAlert, type AlertKind } from '@/lib/arrival-alerts';
import { REFRESH_MS } from '@/lib/config';
import { failed, tapped } from '@/lib/haptics';

const followServer = () => vehiclePollDelay(REFRESH_MS.vehicles);

/**
 * A stop in a vehicle's list means one of two things, and only the rider
 * knows which: they are waiting there for this tram, or they are on it and
 * getting off there. Asked, not guessed — a phone position a few metres from a
 * tram cannot tell "on board" from "standing at the kerb beside it".
 */
function askKind(stopName: string): Promise<AlertKind | null> {
  if (Platform.OS !== 'ios') return Promise.resolve('arrival');
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
      enabled: Boolean(alert) && alert?.vehicleId !== openVehicleId,
      key: alert?.vehicleId ?? '',
      delayMs: followServer,
    },
  );

  useEffect(() => {
    if (detail.data) void arrivalAlertStore.follow(detail.data);
  }, [detail.data]);
  useEffect(() => {
    if (own.data) void arrivalAlertStore.follow(own.data);
  }, [own.data]);
  useEffect(() => {
    // No longer tracked: the run ended or the vehicle left the feed.
    if (own.error instanceof ApiError && own.error.status === 404) void arrivalAlertStore.disarm();
  }, [own.error]);

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
