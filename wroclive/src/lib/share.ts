import { Platform, Share } from 'react-native';

import type { Stop, VehicleDetail } from '@/lib/api';
import { stopShareUrl, vehicleShareUrl } from '@/lib/links';

/**
 * The system share sheet, with the text a person reading it in a chat needs.
 *
 * iOS takes the link as `url` and shows a preview for it; Android has no such
 * field, so there the link is part of the message. A dismissed sheet is not an
 * error, and neither is a platform without one (the web build).
 */
async function share(message: string, url: string) {
  try {
    await Share.share(Platform.OS === 'ios' ? { message, url } : { message: `${message}\n${url}` });
  } catch {
    // Nothing to tell the rider: they closed the sheet, or there is none.
  }
}

export const shareStop = (stop: Stop) =>
  share(`${stop.name} — odjazdy na żywo`, stopShareUrl(stop));

export function shareVehicle(detail: VehicleDetail) {
  const { vehicle, trip } = detail;
  const towards = trip?.towards ?? trip?.headsign;
  const next = trip?.nextStop;
  const parts = [
    `Linia ${vehicle.line}${towards ? ` → ${towards}` : ''}`,
    next ? `następny przystanek: ${next.name}` : null,
  ].filter(Boolean);
  return share(parts.join(', '), vehicleShareUrl(vehicle.id));
}
