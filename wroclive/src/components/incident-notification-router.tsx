import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

/**
 * A tap on a disruption notification opens the disruptions screen.
 *
 * Native only — rendered behind `incidentAlertsAvailable`. The response is
 * cleared once handled: the hook hands back the *last* response on every
 * launch, and without the clear a cold start days later would open the
 * disruptions screen again. Rendered after the `Stack`, so its effect runs
 * once the navigator it pushes onto is mounted.
 */
export function IncidentNotificationRouter() {
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    if (response.notification.request.content.data?.kind !== 'incident') return;
    Notifications.clearLastNotificationResponse();
    router.push('/alerts');
  }, [response, router]);

  return null;
}
