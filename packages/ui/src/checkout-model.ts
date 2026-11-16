// Pure helpers for checking out to a saved address (#48), kept free of JSX so tests can check them.
import { addressLine, addressTitle, formatINRFromPaise, remoteOrderThresholdM, validateDeliveryDetails, type LocationFix, type SavedAddress } from '@market/core';
import { formatDistance } from './address-model.ts';

/** Further than this from the pin, the sheet says the customer isn't in Khed rather than giving a distance. */
export const notInKhedThresholdM = 25_000;

const earthRadiusM = 6_371_000;
/** Great-circle distance in metres between two points. */
export function distanceMetres(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type OrderConfirmation =
  | { kind: 'direct' }
  | { kind: 'remote'; distanceM: number; notInKhed: boolean }
  | { kind: 'unknown' };

/**
 * Whether the order can go straight through. A phone within the threshold of the pin (the same 150 m the owners'
 * flag uses) places directly; further away, or with no fix, the customer confirms first. Never blocks an order.
 */
export function confirmationFor(fix: LocationFix | null, pin: { latitude: number; longitude: number }): OrderConfirmation {
  if (!fix) return { kind: 'unknown' };
  const distanceM = distanceMetres(fix, pin);
  if (!Number.isFinite(distanceM)) return { kind: 'unknown' };
  if (distanceM <= remoteOrderThresholdM) return { kind: 'direct' };
  return { kind: 'remote', distanceM, notInKhed: distanceM > notInKhedThresholdM };
}

export interface ConfirmationCopy { title: string; lead: string; cash: string }
/** The sheet text from the design: how far away, the address, and who pays what in cash. */
export function confirmationCopy(confirmation: Exclude<OrderConfirmation, { kind: 'direct' }>, address: SavedAddress, totalPaise: number): ConfirmationCopy {
  const where = `${addressTitle(address)}, ${addressLine(address)}`;
  const cash = `Make sure someone at the address can take the food and pay ${formatINRFromPaise(totalPaise)} in cash. The restaurant may call you to confirm.`;
  if (confirmation.kind === 'unknown') return { title: 'We couldn\'t confirm where you are', lead: `You're ordering to ${where}. Your phone didn't share its location, so please check this is right.`, cash };
  if (confirmation.notInKhed) return { title: 'You\'re not in Khed right now', lead: `You're ordering to ${where}. Ordering for someone there?`, cash };
  return { title: `You're ${formatDistance(confirmation.distanceM)} from this address`, lead: `You're ordering to ${where}. Is that right?`, cash };
}

/** Contact fields use the shared rules; the typed address line they used to include is not asked any more. */
export function validateContact(details: { name: string; phone: string }): { name: string; phone: string } {
  const { name, phone } = validateDeliveryDetails({ name: details.name, phone: details.phone, addressLine: 'Saved address on file' });
  return { name, phone };
}

export const addressChangedMessage = 'This address changed. Check it and try again.';
export const outsideAreaMessage = 'We can\'t deliver to this address. We deliver in Khed and nearby villages. Choose another address.';
export const addressOutsideReason = 'Outside delivery area';

/** Whether an address can be picked: only inside this restaurant's area. */
export const selectable = (address: SavedAddress) => address.inArea;
