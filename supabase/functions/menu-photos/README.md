# Dish photos

Owner writes use this function; Storage has no client write policies. Public reads
serve only re-encoded card (320px) and detail (960px) WebP versions. `image_url` in
the database is the card's bucket-relative path; services add the public bucket URL.
The function checks Auth server identity and current business membership, allows
only actual JPEG/PNG/WebP decoding, strips metadata, and stores no original.
The maximum input is 5 MiB, 16 megapixels, 8192px per side. Oversized dimensions or
decoder resource failures produce a clear retry/choose-another-photo message.

Before local serving or any later, separately authorized deployment, run
`deno install --frozen` from this directory. The pinned npm WASM file is bundled by
the `static_files` entry in `supabase/config.toml`. Use CLI Docker bundling, since
API-only bundling does not include static files. No runtime CDN or paid image
transformations are required. Run `deno test --frozen --allow-read photos_test.ts`
and `deno check --frozen index.ts`. The GitHub dispatcher workflow runs these checks.

Every upload first persists a reservation covering both immutable object names.
Attachment checks current membership, expected prior pointer, dish, business,
reservation, bucket and both uploaded objects in one database transaction.
Concurrent replacements require reload rather than overwriting a newer photo.
Only the server role may invoke the RPCs or supply an image pointer.

Replacement, removal and dish deletion queue the old version transactionally.
Partially uploaded and crashed requests remain pending until their 15 minute
reservation expires (longer than the hosted function's maximum execution time).
Claim and attachment lock the same ledger row: live reservations and attached
versions cannot be claimed; a claimed expired reservation cannot attach. Storage
requests time out after 10 seconds and do not overwrite/reuse old paths.
Cleanup uses the Storage API, never SQL metadata deletion. Each owner photo
operation drains up to five due versions from that business. **Retry photo cleanup**
in the owner menu drains another batch, including when a dish has been deleted.
Failures leave a two-minute retry lease and durable records. Successful cleanup
retains a small `cleaned` audit record without storing the image bytes.

No scheduler is provisioned here. For unattended cleanup, a future authorized
scheduler can invoke the same cleanup action as a business owner; do not expose
service credentials to a client. Until then, queued objects remain discoverable
and owners can drain them explicitly. If a response is lost, reload the dish's
current photo before retrying. Do not replay a stale expected pointer.
