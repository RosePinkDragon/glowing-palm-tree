// Pure helpers for the saved-address screens (#48), kept free of JSX so tests can check them.
import { validateAddressDraft, type AddressDraft, type AddressLabel, type SavedAddress } from '@market/core';

/** What the form edits. The pin is only ever set from the phone's location in this slice (map pin is #49). */
export interface AddressForm {
  label: AddressLabel;
  customLabel: string;
  house: string;
  streetArea: string;
  landmark: string;
  location: { latitude: number; longitude: number; source: 'gps' | 'pin' } | null;
}
export type AddressFormErrors = Partial<Record<'customLabel' | 'house' | 'streetArea' | 'landmark' | 'location', string>>;

export const maxSavedAddresses = 20;
export const locationRequiredMessage = 'Use your current location to set the delivery pin. It is required to save the address.';

export const emptyAddressForm: AddressForm = { label: 'home', customLabel: '', house: '', streetArea: '', landmark: '', location: null };

export function formFromAddress(address: SavedAddress): AddressForm {
  return { label: address.label, customLabel: address.customLabel ?? '', house: address.house, streetArea: address.streetArea, landmark: address.landmark ?? '',
    location: { latitude: address.latitude, longitude: address.longitude, source: address.locationSource } };
}

/** "850 m" under 1 km, one decimal under 10 km, whole km above; empty when the restaurant's kitchen point is unknown. */
export { formatDistance } from '@market/core';

/** The draft to send, or per-field messages. Location copy is specific to GPS, since there is no map yet. */
export function checkAddressForm(form: AddressForm): { draft: AddressDraft } | { errors: AddressFormErrors } {
  if (!form.location) {
    const errors: AddressFormErrors = { location: locationRequiredMessage };
    try { validateAddressDraft({ label: form.label, customLabel: form.customLabel, house: form.house, streetArea: form.streetArea, landmark: form.landmark, latitude: 0, longitude: 0, locationSource: 'gps' }); }
    catch (error) { Object.assign(errors, fieldsOf(error)); }
    return { errors };
  }
  try {
    return { draft: validateAddressDraft({ label: form.label, customLabel: form.customLabel, house: form.house, streetArea: form.streetArea, landmark: form.landmark,
      latitude: form.location.latitude, longitude: form.location.longitude, locationSource: form.location.source }) };
  } catch (error) {
    const errors = fieldsOf(error);
    if (errors.location) errors.location = locationRequiredMessage;
    if (!Object.keys(errors).length) throw error;
    return { errors };
  }
}
function fieldsOf(error: unknown): AddressFormErrors {
  const fields = (error as { fields?: Record<string, string> } | null)?.fields;
  return fields ? { ...fields } : {};
}

/** Friendly copy for a failed save or delete. Services already word most errors; these two are fixed here. */
export function addressErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ADDRESS_CHANGED') return 'This address was changed elsewhere. Reload and try again.';
  if (code === 'ADDRESS_LIMIT') return `You can save up to ${maxSavedAddresses} addresses. Delete one to add another.`;
  if (code === 'INVALID_ADDRESS') return 'Check the address and try again.';
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
}

/** Friendly copy when the phone's location can't be read for the pin. */
export function locationErrorMessage(error: unknown): string {
  if ((error as { code?: string } | null)?.code === 'INVALID_LOCATION_FIX') return 'We couldn\'t get an accurate location. Move to an open area and try again.';
  const message = error instanceof Error ? error.message : '';
  if (/permission/i.test(message)) return 'Location permission is off. Allow location access for this app in your settings and try again, or save later.';
  return message || 'We couldn\'t read your location. Check that location is on and try again.';
}

/** The apps named in "Changes apply in both…", this restaurant first as in the design. */
export function bothAppsNote(names: readonly [string, string]): string {
  return `Changes apply in both the ${names[0]} and ${names[1]} apps. Past orders keep the address they were delivered to.`;
}

export const addDeliveryAddressPrompt = 'Add delivery address';
/** The customer top bar's address line: "Home · 12, Station Road" for the selected saved address, else a neutral prompt. */
export function deliveryAddressLine(address: Pick<SavedAddress, 'label' | 'customLabel' | 'house' | 'streetArea'> | null | undefined): string {
  if (!address) return addDeliveryAddressPrompt;
  const label = address.label === 'other' ? address.customLabel?.trim() || 'Other' : address.label === 'work' ? 'Work' : 'Home';
  return `${label} · ${address.house.trim()}, ${address.streetArea.trim()}`;
}
