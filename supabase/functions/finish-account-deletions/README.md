Removes the Auth user of every account that `request_account_deletion()` left in `deletion_pending` (#51). Orders were already unlinked and are kept; the retention purge handles their customer details.

Authentication: `POST` with `Authorization: Bearer <FINISH_ACCOUNT_DELETIONS_SECRET>` (at least 32 characters; constant-time comparison; a missing or short secret authorizes nobody). Gateway JWT verification is off for this function only because the secret is checked before any database or Auth work.

Per account: `prepare_account_auth_deletion` (repeat the cleanup under the account lock; refuses accounts that are not pending), then `DELETE /auth/v1/admin/users/<id>` (404 counts as done), then `complete_account_auth_deletion` (refuses unless the user is really gone, then records the completion). Accounts are processed oldest first in pages of `FINISH_ACCOUNT_DELETIONS_BATCH` (default 20, max 50), at most five pages and about 100 seconds per run. One failing account does not stop the others. The response is JSON counts only; logs carry fixed words only, never ids, phone numbers or tokens.

Tests: `deno test supabase/functions/finish-account-deletions/finish_test.ts` and `deno check supabase/functions/finish-account-deletions/index.ts` (the `dispatcher` CI job runs both). Setup, scheduling and the daily check: docs/RELEASE.md, "Finish account deletions".
