Run `tests/database/run.sh` with Docker available. It creates a disposable PostgreSQL 17/PostGIS 3.5 Alpine container, with no published port, and removes it on exit. It exercises the migration and seed with both fresh and existing PostGIS installations, real PostgreSQL roles and RLS. The small `auth` fixture supplies the Supabase authentication interface; it does not replace database policies or SQL execution. Full Supabase Auth and Realtime integration require a separate local stack test.

The seed is demonstration data. Both businesses have ordering disabled and no service area. A trusted operator must supply and verify a real boundary, source and version before enabling orders. Location coordinates do not establish physical presence. The eventual checkout and status transition RPCs must enforce server pricing, idempotency, location and transition rules; this migration deliberately grants no direct client order writes.

Owner identity/history (#98): `business_memberships.display_name` is scoped to the
restaurant. The migration backfills the neutral name `Owner`; no customer profile
or auth metadata is read. A trusted operator can set an actual supplied name with
`update public.business_memberships set display_name = 'Supplied owner name' where
business_id = '<restaurant UUID>' and user_id = '<owner UUID>';`. New membership
setup in #59 must supply the restaurant-scoped name. Clients have no membership
write grant. Existing historical steps are not assigned a guessed historic name;
new owner transitions snapshot the name into `order_history_actors`.

Owner services request `order_history_actors(actor_name)` nested in safe history
and map it to optional `history[].actorName`, for #101. Customer reads explicitly
select only `status, created_at`; direct actor-ledger reads require restaurant
admin membership under RLS. Neither the actor ledger nor the old history table
is published to Realtime. Existing `orders` invalidations refresh both timelines.
Use security-invoker views if exposing these relations through a future view;
never grant a definer-view path around the owner RLS policy.

For #51, revoke sessions first, then in one trusted deletion transaction remove
all memberships, call `public.redact_owner_history(user_uuid)` as `service_role`,
and delete the identity after other account dependencies are handled. The redaction
primitive locks the `auth.users` identity row `FOR UPDATE` before checking that
memberships are absent. Removing memberships first waits for earlier transitions;
a concurrent regrant that finished before the identity lock is caught by the absence
check. A later regrant blocks. Its private definer
implementation grants no app execution or direct auth-table access. The lock blocks
new membership grants through their identity FK across every business until the
transaction finishes. Never commit between redaction and identity deletion.

The function refuses active memberships, preserves status/timestamps, replaces
actor names with `Former owner`, clears identity references, and is safe to call
again. Membership removal waits for in-flight transitions, which already hold a
shared membership lock. The deletion orchestrator must retry the whole transaction
on PostgreSQL deadlock/serialization errors; existing order transitions also take
identity FK locks, so a raced deletion may be chosen as a deadlock victim. Ordinary
membership removal alone preserves historical names.
This primitive does not implement account deletion, session revocation or owner
management. No production migration is executed by the test suite.
