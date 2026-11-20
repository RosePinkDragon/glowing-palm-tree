Run `tests/database/run.sh` with Docker available. It creates a disposable PostgreSQL 17/PostGIS 3.5 Alpine container, with no published port, and removes it on exit. It exercises the migration and seed with both fresh and existing PostGIS installations, real PostgreSQL roles and RLS. The small `auth` fixture supplies the Supabase authentication interface; it does not replace database policies or SQL execution. Full Supabase Auth and Realtime integration require a separate local stack test.

The seed is demonstration data (it uses the order prefixes `AMS` and `KDI`; real launch rows are created as described in `docs/RELEASE.md` step 5). Both businesses have ordering disabled and no service area. A trusted operator must supply and verify a real boundary, source and version before enabling orders. Location coordinates do not establish physical presence. The eventual checkout and status transition RPCs must enforce server pricing, idempotency, location and transition rules; this migration deliberately grants no direct client order writes.

The run applies every file in `supabase/migrations` (the single pre-release baseline, #131) once per PostGIS layout: `all_fresh` (a fresh install) and `all_existing` (PostGIS already in `public`). It then applies `seed.sql` and `helpers.sql` and runs every suite and the concurrent races against that schema. Suites that share `final-fixture.sql` (isolation, checkout, notifications, notification-routing, accepting-orders, pricing) run in that order. Orders are always placed through a saved address (`customer_addresses` row plus `address_id`/`address_version`) with the exact accepted-pricing quote from `test_quote`. There is no upgrade path to test before the first persistent deployment; after it, add upgrade checks for each forward-only migration.

`customer-notifications.sql` checks every event, placement and source-event replay,
push retries/device independence, transaction rollback, RLS/column permissions,
all four RPCs, owner/dual-role denial, restaurant isolation, keyset ties and
microseconds, monotonic read markers, and trusted expiry/lifecycle cleanup.
`customer-notifications-races.sh` is sourced in both final-schema layouts. It
observes real lock waits for concurrent placement replay and stale-version
transitions, then checks persisted order/event counts and the losing result.
The feed stays outside Realtime. Cleanup is callable only by trusted code; these
tests install no pg_cron and configure no scheduler or remote Supabase project.

`owner-display-name.sql` verifies the private definer/public invoker boundary,
minimal grants, self/restaurant scope, active sessions, the unchanged Unicode
name constraint and immutable history snapshots. `owner-display-name-races.sh`
observes real PostgreSQL lock waits in both rename/transition orderings, then
checks persisted step names. It also races membership revocation and session
expiry against a waiting rename. Both suites run in the final-schema pass for
both PostGIS layouts; they do not contact a remote project.

`owner-login.sql` covers the owner code request log and `claim_owner_code_attempt` (#50): no client grants, RLS without policy,
outside Realtime, no column that could hold a code or token, ownership by admin membership and full phone number (the restaurant,
unknown or missing slug, plus-sign handling), input validation, every rate limit and its sliding window (per phone 15 minutes and
day, per IP, null addresses, per restaurant sends), the log growth cap, provider-failure marking, restaurant deletion, and the trusted
90-day purge. The races in `run.sh` fire simultaneous claims from real sessions (eight for one number, fourteen for one address,
six owners against the restaurant cap) and require exactly the permitted number to pass, then hold one claim open and observe a
second blocked behind it. No pg_cron or remote project is involved.

`offers.sql` (#182 slice A) covers offers and order discounts: every constraint, RLS and grants (owners manage their own restaurant's
offers; signed-out visitors see only active automatic offers and never a code, limit or count; customers have no table access), the
acceptance examples, pricing rules, place-time changes (`offer_changed`), exact replay with the code in the request hash, the code rate
limit, the Asia/Kolkata daily window and cancellation giving a use back. `offers-races.sh` observes the real offer lock wait for the last
use, races six orders for two uses (automatic and code), and races one customer's two orders against a per-customer limit and first order
only, plus a concurrent identical request. Both run in the final-schema pass for both PostGIS layouts.
