# Restaurant settings service (#60 backend)

Both businesses expose `getRestaurantSettings()` and `saveRestaurantSettings(input)`
through `createMarketServices`. The read also returns the developer-controlled `orderPrefix` and a `deliveryArea` status (`radius` from a `radius-<m>m` version, `verified`, or `unverified`) taken from the business row's status columns, never the polygon. These methods require the admin audience; server
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

# Customer notification feed (#55 backend)

Customer services expose `listNotifications({ limit?, cursor? })`,
`markNotificationRead(id)`, `markAllNotificationsRead()` and
`getUnreadNotificationCount()`. Every call uses the configured restaurant and a
verified signed-in customer, and fences results on sign-out, identity change and
disposal. Admin-audience calls fail with `CUSTOMER_REQUIRED`; the database also
denies owners of the target restaurant, including dual-role identities.

Pages contain `notifications` and `nextCursor`, ordered newest first by timestamp
and UUID. The server reads one lookahead row; the service returns at most `limit`
(default 20, maximum 100). Pass the raw `createdAtISO`/`id` cursor back unchanged:
JavaScript Date conversion discards microseconds. Each notification exposes only
`id`, restaurant slug `businessId`, `orderId`, `eventStatus`, `title`, `body`,
`readAtISO` and `createdAtISO`; it contains no actor or owner data. All six order
statuses are supported. Reads/counts cover the last 30 days; listing does not
change read state. Mark-one returns false for missing/inaccessible/expired rows;
otherwise it returns true, including retries. Mark-all returns the number newly
read. Only `read_at` is client-writable; its timestamp is assigned by the server
and cannot be cleared or changed after it is set.

Malformed input uses `INVALID_NOTIFICATION_QUERY`; malformed server data uses
`INVALID_RESPONSE`. RPC denial uses `NOTIFICATION_ACCESS_DENIED`, and other RPC
or transport failures use `NOTIFICATION_REQUEST_FAILED`. Existing
`SIGN_IN_REQUIRED`, `SESSION_CHANGED`, `DISPOSED` and `DEMO_MODE` codes also apply.
There are no feed Realtime subscriptions. The trusted cleanup functions and later
lifecycle callers are described in `docs/RELEASE.md`; no scheduling is configured.
