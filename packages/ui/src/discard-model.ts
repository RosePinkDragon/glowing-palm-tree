// Pure "unsaved changes" rules (#200), free of React so they can be unit tested. A form is dirty only when its
// normalized editable fields differ from the baseline it was opened with (or last saved as); typing and then
// undoing, or whitespace-only edits, are not changes.
import type { AddressForm } from './address-model.ts';
import type { DishDraft } from './menu-model.ts';
import { parseRupees } from './admin-model.ts';
import type { DetailsForm } from './restaurant-details-model.ts';

export const discardCopy = {
  title: 'Discard changes?',
  message: 'You have unsaved changes. If you leave now they will be lost.',
  keep: 'Keep editing',
  discard: 'Discard changes',
} as const;

const trim = (value: string | null | undefined) => (value ?? '').trim();
/** Coordinates are compared to 6 decimals (about 10 cm): a refreshed GPS fix is a change, float noise is not. */
const coordinate = (value: number) => value.toFixed(6);

export function normalizeAddress(form: AddressForm) {
  return {
    label: form.label,
    // The custom name only exists for the "other" label; typing one and switching back to Home does not count.
    customLabel: form.label === 'other' ? trim(form.customLabel) : '',
    house: trim(form.house), streetArea: trim(form.streetArea), landmark: trim(form.landmark),
    location: form.location ? `${coordinate(form.location.latitude)},${coordinate(form.location.longitude)}:${form.location.source}` : null,
  };
}
export const addressIsDirty = (baseline: AddressForm, current: AddressForm) => !sameValues(normalizeAddress(baseline), normalizeAddress(current));

export function normalizeDish(draft: DishDraft) {
  const paise = parseRupees(draft.price);
  return {
    id: draft.id ?? null, name: trim(draft.name), description: trim(draft.description), categoryId: draft.categoryId,
    // "250", "250.0" and " 250.00 " are the same price; unparseable text is compared as typed.
    price: paise === null ? `text:${trim(draft.price)}` : `paise:${paise}`,
    diet: draft.diet, isAvailable: draft.isAvailable, isFeatured: draft.isFeatured, isDemo: draft.isDemo,
  };
}
export const dishIsDirty = (baseline: DishDraft, current: DishDraft) => !sameValues(normalizeDish(baseline), normalizeDish(current));

export function normalizeDetails(form: DetailsForm) {
  const phone = (value: string) => value.replace(/[\s-]/g, '');
  const amount = (value: string) => { const paise = parseRupees(value); return paise === null ? `text:${trim(value)}` : `paise:${paise}`; };
  return { contactPhone: phone(form.contactPhone), whatsappPhone: phone(form.whatsappPhone), deliveryFee: amount(form.deliveryFee), minOrder: amount(form.minOrder) };
}
export const detailsAreDirty = (baseline: DetailsForm, current: DetailsForm) => !sameValues(normalizeDetails(baseline), normalizeDetails(current));

function sameValues(a: object, b: object) {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).every(key => x[key] === y[key]);
}

