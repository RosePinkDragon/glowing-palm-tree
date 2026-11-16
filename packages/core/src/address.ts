import { DomainValidationError, type DomainFieldErrors } from './domain.ts';

/** Saved delivery addresses (#48): one customer's list, shared by both restaurant apps. No PIN code. */
export type AddressLabel = 'home' | 'work' | 'other';
export type AddressLocationSource = 'gps' | 'pin';

export interface AddressDraft {
  label: AddressLabel;
  /** Only for "other", up to 40 characters. */
  customLabel?: string;
  house: string;
  streetArea: string;
  landmark?: string;
  latitude: number;
  longitude: number;
  locationSource: AddressLocationSource;
}

export interface SavedAddress extends AddressDraft {
  id: string;
  /** Bumped by the server on every edit; checkout sends it so a changed address is refused. */
  version: number;
  updatedAtISO: string;
  /** Inside this restaurant's verified delivery area (server-decided). */
  inArea: boolean;
  /** Metres from this restaurant's kitchen; null when the kitchen point isn't set. */
  distanceM: number | null;
}

/** The copy of the address stored on an order; later edits to the saved address never change it. */
export interface OrderAddress {
  label: AddressLabel;
  customLabel?: string;
  house: string;
  streetArea: string;
  landmark?: string;
  locationSource: AddressLocationSource;
}

export const addressLabels: Record<AddressLabel, string> = { home: 'Home', work: 'Work', other: 'Other' };

export function isAddressLabel(value: unknown): value is AddressLabel {
  return value === 'home' || value === 'work' || value === 'other';
}
export function isAddressLocationSource(value: unknown): value is AddressLocationSource {
  return value === 'gps' || value === 'pin';
}

/** "Home", "Work", or the custom name for other (falling back to "Other"). */
export function addressTitle(address: Pick<AddressDraft, 'label' | 'customLabel'>): string {
  return address.label === 'other' && address.customLabel ? address.customLabel : addressLabels[address.label];
}

/** One line for lists and the rider: house, street/area, landmark. */
export function addressLine(address: Pick<AddressDraft, 'house' | 'streetArea' | 'landmark'>): string {
  return [address.house, address.streetArea, address.landmark].filter(Boolean).join(', ');
}

// Same rules as the database (customer_addresses checks), so errors show beside the field:
// control, zero-width and direction-override characters are refused; ZWJ/ZWNJ stay for Indic scripts.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

export function validateAddressDraft(input: AddressDraft): AddressDraft {
  const fields: DomainFieldErrors = {};
  const text = (value: string | undefined) => (value ?? '').trim();
  const house = text(input.house), streetArea = text(input.streetArea), landmark = text(input.landmark);
  const customLabel = input.label === 'other' ? text(input.customLabel) : '';
  if (!isAddressLabel(input.label)) fields.label = 'Choose Home, Work or Other.';
  if (customLabel.length > 40 || controlCharacters.test(customLabel)) fields.customLabel = 'Use up to 40 characters for the name.';
  if (!house) fields.house = 'Enter the house or flat number and building.';
  else if (house.length > 120 || controlCharacters.test(house)) fields.house = 'Use up to 120 characters.';
  if (!streetArea) fields.streetArea = 'Enter the street or area.';
  else if (streetArea.length > 200 || controlCharacters.test(streetArea)) fields.streetArea = 'Use up to 200 characters.';
  if (landmark.length > 120 || controlCharacters.test(landmark)) fields.landmark = 'Use up to 120 characters.';
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
      !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) fields.location = 'Set the delivery pin on the map.';
  if (!isAddressLocationSource(input.locationSource)) fields.location = 'Set the delivery pin on the map.';
  if (Object.keys(fields).length) throw new DomainValidationError('INVALID_ADDRESS', 'Check the address.', fields);
  return {
    label: input.label, ...(customLabel ? { customLabel } : {}), house, streetArea, ...(landmark ? { landmark } : {}),
    latitude: input.latitude, longitude: input.longitude, locationSource: input.locationSource,
  };
}
