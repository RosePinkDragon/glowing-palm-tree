# Restaurant settings service (#60 backend)

Both businesses expose `getRestaurantSettings()` and `saveRestaurantSettings(input)`
through `createMarketServices`. These methods require the admin audience; server
authorization is always authoritative. Public `getBusiness()` includes
`contactPhone`, `whatsappPhone`, `settingsVersion` and the current fee/minimum;
existing business Realtime invalidations prompt consumers to refresh those values.

A save sends **all four fields** plus `expectedVersion` from the owner's last
read. Contact is required; WhatsApp is nullable. Indian national, trunk-prefixed,
`91` and `+91` phone formats normalize to E.164; WhatsApp accepts mobiles only.
Money uses whole integer paise (fee 0–100,000; minimum 0–1,000,000).
`restaurantAmountPaise(text, field)` parses rupees without rounding; malformed or
more-than-two-decimal values are refused. `RestaurantSettingsValidationError`
extends `ServiceError` with `code: INVALID_SETTINGS` and field-specific `fields`.

The save is bound to its initiating owner/session. `SETTINGS_CHANGED` requires
refreshing and reviewing the current settings; do not retry automatically with a
new version. `ADMIN_REQUIRED` means access/session no longer permits the write.
A failed or missing confirmation is not success: refresh to establish the stored
values before retrying. Reads may return a null contact until trusted setup or
the first valid owner save; saving requires a contact. Sample numbers are never
seeded by this change.

The API RPC is an invoker wrapper over a private-schema definer, with an active
session and locked current membership check. It can update only these four
columns, and uses the same business-row lock as checkout. Every settings update
advances the version, including a no-op save or trusted administrative edit;
open/closed changes do not. Clients gain no direct business UPDATE privileges.
Checkout retains its accepted-pricing/idempotency protocol; placed orders retain
their fee and total snapshots.

This is a backend/services slice. Restaurant-details screens and Help contact
wiring remain follow-up work; issue #60 must remain open. No remote project is
linked or deployed. At #131's baseline cutover, fold the settings migration into
the unapplied baseline and retain `tests/database/restaurant-settings.sql` plus
the sourced race suite for **both** PostGIS layouts. The tests use disposable
local databases and never contact a hosted project.
