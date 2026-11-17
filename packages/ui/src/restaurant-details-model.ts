import { restaurantAmountPaise, RestaurantSettingsValidationError, validateRestaurantSettings, type DeliveryAreaStatus, type RestaurantSettings, type SaveRestaurantSettingsInput } from '@market/services';

// Pure form model for the owners' Restaurant details screen (#60). Rules come from the services
// validator, so the screen and the server-side write path can never disagree.
export type DetailsField = 'contactPhone' | 'whatsappPhone' | 'deliveryFee' | 'minOrder';
export const detailsFieldOrder: readonly DetailsField[] = ['contactPhone', 'whatsappPhone', 'deliveryFee', 'minOrder'];
export type DetailsForm = Record<DetailsField, string>;
export type DetailsErrors = Partial<Record<DetailsField, string>>;
export type DetailsResult = { ok: true; input: SaveRestaurantSettingsInput } | { ok: false; errors: DetailsErrors; formError?: string };

/** Integer paise to the rupee text an owner types: whole rupees stay plain, otherwise two decimals. */
export function paiseToRupees(paise: number): string {
  const whole = Math.floor(paise / 100), fraction = paise % 100;
  return fraction ? `${whole}.${String(fraction).padStart(2, '0')}` : String(whole);
}

/** "+919820044556" as "+91 98200 44556"; anything unexpected is shown as stored. */
export function displayPhone(phone: string | null): string {
  const match = phone?.match(/^\+91([0-9]{5})([0-9]{5})$/);
  return match ? `+91 ${match[1]} ${match[2]}` : phone ?? '';
}

export function formFromSettings(settings: RestaurantSettings): DetailsForm {
  return { contactPhone: displayPhone(settings.contactPhone), whatsappPhone: displayPhone(settings.whatsappPhone), deliveryFee: paiseToRupees(settings.deliveryFeePaise), minOrder: paiseToRupees(settings.minOrderPaise) };
}

/** "12 km around the kitchen" for a radius, otherwise a generic line; never claims an area that is not verified. */
export function deliveryAreaText(area: DeliveryAreaStatus): string {
  if (area.kind === 'radius') { const km = area.radiusM / 1000; return `${Number.isInteger(km) ? km : km.toFixed(1).replace(/\.0$/, '')} km around the kitchen`; }
  return area.kind === 'verified' ? 'Set by your developer' : 'Not set yet — ask your developer';
}
export const orderNumberFormat = (prefix: string) => `${prefix}-YYYYMM0001`;

export function firstErrorField(errors: DetailsErrors): DetailsField | null {
  return detailsFieldOrder.find(field => errors[field]) ?? null;
}

const amountField = { deliveryFee: 'deliveryFeePaise', minOrder: 'minOrderPaise' } as const;

/** Validate every field together; any error means nothing is sent. Amounts become exact integer paise from the typed text. */
export function validateDetailsForm(form: DetailsForm, version: number): DetailsResult {
  const errors: DetailsErrors = {};
  const paise = { deliveryFee: 0, minOrder: 0 };
  for (const field of ['deliveryFee', 'minOrder'] as const) {
    try { paise[field] = restaurantAmountPaise(form[field], amountField[field]); }
    catch (error) { errors[field] = error instanceof RestaurantSettingsValidationError ? error.fields[amountField[field]] ?? 'Enter an amount in rupees.' : 'Enter an amount in rupees.'; }
  }
  let input: SaveRestaurantSettingsInput | null = null;
  try {
    input = validateRestaurantSettings({ contactPhone: form.contactPhone, whatsappPhone: form.whatsappPhone.trim() ? form.whatsappPhone : null, deliveryFeePaise: paise.deliveryFee, minOrderPaise: paise.minOrder, expectedVersion: version });
  } catch (error) {
    if (!(error instanceof RestaurantSettingsValidationError)) throw error;
    if (error.fields.contactPhone) errors.contactPhone = error.fields.contactPhone;
    if (error.fields.whatsappPhone) errors.whatsappPhone = error.fields.whatsappPhone;
    if (error.fields.expectedVersion) return { ok: false, errors, formError: error.fields.expectedVersion };
  }
  return input && !Object.keys(errors).length ? { ok: true, input } : { ok: false, errors };
}

/** Server-side field names back to form fields. */
export function serverFieldErrors(fields: Partial<Record<string, string>>): DetailsErrors {
  const errors: DetailsErrors = {};
  if (fields.contactPhone) errors.contactPhone = fields.contactPhone;
  if (fields.whatsappPhone) errors.whatsappPhone = fields.whatsappPhone;
  if (fields.deliveryFeePaise) errors.deliveryFee = fields.deliveryFeePaise;
  if (fields.minOrderPaise) errors.minOrder = fields.minOrderPaise;
  return errors;
}
