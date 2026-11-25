# Test inventory and assertion-quality baseline

Baseline: `d6edc07dca24e929d8803629f1bff2032885dc3c` (main, 2026-11-25). This is an audit, not a coverage or mutation score. No test was removed or rewritten. Measurements are a single run on a shared Linux machine; durations are observations, not budgets.

## Reproduce and interpret

Run `node scripts/test-inventory.mjs` from the repository root for the current tracked file inventory. It lists each file and counts lexical test declarations, recognized `assert`, `assert.method`, `expect` and `test_assert` call sites and skip/todo markers; it does not parse syntax, execute tests, count assertions reached, or identify loop iterations. Comments, helpers, dynamic tests, SQL exception checks and browser implicit waits make those lexical counts approximate. The output is generated from tracked files, not a hand-maintained total. `git ls-files` requires Git and a checkout. Runner summaries below count cases reported at runtime; browser and SQL scripts do not expose equivalent case or assertion counts. Do not add file, case, call-site and invocation counts together.

The static inventory at the baseline reports 41 Node test files, 4 Deno test files, 27 browser modules, 32 SQL/shell database files and 4 workflows. Browser modules include three helpers (`offer-mocks.mjs`, `otp-login.mjs`, `dish-sheet.mjs`), not independent suites. Database files include `fixture.sql`, `final-fixture.sql`, `helpers.sql` and `run.sh`; the SQL suites and race scripts use those shared fixtures. Static skip/todo-marker search returned zero; that is not proof of zero conditional skips. Runner-reported skips are listed below. The matcher omits other assertion names (including `assertEquals`), and call sites are not assertion executions or evidence of assertion strength.

## Executed measurements

Node 24.22.3, npm 11.19.1 and Deno 2.9.6; dependencies installed with `npm ci`. Commands were run on the baseline source. Node counts and durations come from the Node reporter, while wall times use Bash `time`; Deno counts come from its reporter. Package durations are reporter times per package, not sums of isolated test times. Tests run concurrently with some other suites, so times are not directly comparable to CI. `test:packages` executes all four package scripts. Browser timings include process startup and each script's internal journeys. SQL runner runs both PostGIS layouts with shared fixtures and real concurrent sessions; it does not report individual case counts or per-file timings.

| CI job / command | Result | Measured time |
| --- | --- | --- |
| App CI `quality`: `npm run test:workspaces` | 9 passed, 0 failed, 0 skipped | 4.640 s wall |
| App CI `quality`: `npm run test:config` | 3 passed, 0 failed, 0 skipped | 0.620 s wall |
| App CI `quality`: `npm run test:web-export` | 4 passed, 0 failed, 0 skipped | 0.497 s wall |
| App CI `quality`: `npm run test:packages` / core | 17 passed, 0 failed, 0 skipped | 0.133 s runner |
| same / notifications | 27 passed, 0 failed, 0 skipped | 0.802 s runner |
| same / services | 115 passed, 0 failed, 0 skipped | 29.301 s runner |
| same / UI | 143 passed, 0 failed, 0 skipped | 0.274 s runner |
| App CI `tests`: the five `.github/scripts/` test files named by the workflow | 64 passed, 0 failed, 0 skipped | 3.783 s wall |
| App CI `postgis-rls`: `tests/database/run.sh` | passed both layouts; case and skip totals unavailable | 323.674 s wall |
| App CI `dispatcher`: `deno test supabase/functions/dispatch-notifications/dispatch_test.ts` | 7 passed, 0 failed | 1.952 s wall |
| same: `deno test supabase/functions/request-owner-code/handler_test.ts supabase/functions/send-sms-hook/hook_test.ts` | 24 passed, 0 failed | 1.548 s wall |
| same: from `supabase/functions/menu-photos`, `deno test --frozen --allow-read photos_test.ts` | 7 passed, 0 failed | 3.883 s wall |

TypeScript checking and all three Deno entry-point checks also passed. The first sandboxed workspace attempt produced 9 failures from `spawnSync ... EPERM`; the successful rerun allowed subprocess access. The Deno tests have no network permission; their provider/database ports are fakes. `npm run test:core` is an alias for the core package command, not an additional CI invocation. The initial dependency install failed because the default npm cache was unwritable; `npm ci --cache /tmp/issue205-npm-cache` succeeded.

## CI and fixture ownership

* `.github/workflows/app-ci.yml` runs `quality` (`npm run check`, including the Node commands above), `tests` (delivery and migration policy unit tests), `postgis-rls` (the complete `tests/database/run.sh`), `dispatcher` (Deno tests plus checks), and `export` (builds, not tests). `tests/database/run.sh` owns its disposable PostGIS container, roles and fixture state; the six final-fixture suites run in order and the remaining SQL suites roll back. Its race scripts deliberately use committed fixtures and real sessions. `tests/database/README.md` describes that ownership and ordering. No remote Supabase project is used.
* `.github/workflows/browser-qa.yml` builds four apps against a fixture URL and runs the `smoke`, `cart-photos`, `brand-menu-kokani-checkout` and `inbox-leave` shards. The smoke script imports `account.mjs`, `addresses48.mjs`, `closed58.mjs`, `owner-menu.mjs`, `owner58.mjs`, `owner48.mjs`, `owner60.mjs` and `owner53name.mjs` in its normal mode. Their absence as explicit workflow commands does not make them orphans. The other three browser modules are reusable helpers. The browser scripts own intercepted HTTP/socket fixtures and local storage; they cannot establish real Auth, Realtime, provider or deployed backend behavior.
* `.github/workflows/delivery-policy.yml` evaluates live PR/issue metadata on trusted main; it is a gate rather than a test suite. `manual-eas-build.yml` is manually dispatched and is not an automatic PR test or a deployment performed for this audit. No orphaned standalone suite was found among the discovered Node, Deno, browser and database files by static inspection of package scripts, workflow commands and imports; recheck discovery patterns and CI paths when files move.

## Business contracts and oracle review

Findings here are **static inspection**, not mutation-tested proof. The suggested actions are candidates, not instructions to delete tests. A mock can validate request shape or rendering, but cannot prove the server actually persists the corresponding result.

| Contract | Defending evidence and decision | Limitation / next test |
| --- | --- | --- |
| Checkout, order idempotency and pricing | **Keep** `tests/database/checkout.sql`, `pricing.sql` and the same-key, close and address races in `tests/database/run.sh`: they query stored orders, counters and address versions. `tests/browser/quick-checkout187.mjs` asserts request payload and stored recipient state against a mock. | **Strengthen** `packages/ui/src/checkout-state.test.ts` delayed-result test: it asserts a local `visible` variable set by a callback written in the test, not the real UI/service flow. Exercise a delayed response through the real checkout screen and assert no order details or storage appear after identity change; retain the DB tests. |
| Order reads and tenant/role boundaries | **Keep** `tests/database/isolation.sql` checks privileges and rows under different roles, including denied cross-tenant changes and revocation; `packages/services/src/customer-orders.test.ts` checks query filters and pagination with synthetic responses. | **Missing** full local Auth/Realtime integration: SQL auth fixture and mock transport do not prove token/session delivery or subscription revocation. Add a local-stack integration test without remote access. |
| Offers and discounts | **Keep** `tests/database/offers.sql` and `offers-races.sh` for persisted discounts, limits and competing claims; `packages/services/src/offers.test.ts` validates request bodies and malformed responses. | **Strengthen** the browser-to-database seam: `tests/browser/customer-offers182.mjs` implements pricing in a mock, so a passing UI cannot prove actual server totals. Preserve both layers until a local integration test verifies the accepted quote and persisted order. |
| Notifications and membership | **Keep** `tests/database/notifications.sql`, `customer-notifications.sql`, and `customer-notifications-races.sh`: outbox rows, leases, read markers and stale transitions are observed. `supabase/functions/dispatch-notifications/dispatch_test.ts` checks recipient and provider-port calls. | **Missing** a local end-to-end delivery/acknowledgment path with a controlled provider; the dispatcher fake cannot prove deployed scheduling or provider delivery. |
| Cart and undo | **Keep** `packages/ui/src/cart-state.test.ts` checks stored owner and lines; `tests/browser/cart-undo204.mjs` checks saved cart, accessibility and reload. | **Strengthen** cross-restaurant transition in the real browser: the browser test explicitly delegates it to unit tests. Verify the visible cart and persistent storage after changing restaurant. |
| Authorization and lifecycle | **Keep** `tests/database/customer-relationships.sql`, `leave-business.sql` and corresponding races for persisted state and concurrent lifecycle; `packages/services/src/leave-business.test.ts` checks response binding and session changes with mocked transport. | **Merge candidate**, low priority: compare overlapping malformed response mapping cases in `customer-relationships.test.ts` and `leave-business.test.ts`; retain distinct join/leave and DB/race behavior. Establish equivalence before merging. No removal is justified by this audit. |

## Follow-ups, ordered by risk and cost

1. Strengthen the delayed checkout identity oracle and browser cart scope transition (high risk, modest targeted work; no claimed runtime saving).
2. Add local-stack authorization, checkout/offer and notification integration with controlled providers (high risk, larger setup cost; do not replace PostGIS race checks).
3. Measure individual browser and SQL cases and compare the join/leave mapping overlap before considering a merge (lower risk; potential savings unquantified). Preserve the distinct server, UI and concurrency contracts.
4. **Remove: none identified.** Consider removal only after a specific redundant case has an identified survivor and equivalent observable failure behavior. No mutation testing was performed, and no blanket reduction target is supported.

## SQL file and sourced race timings

A second, successful run used `BASH_ENV=/tmp/issue205-trace-env bash -x tests/database/run.sh`, with `PS4` set to `'+$(date +%s%3N) ${BASH_SOURCE}:${LINENO} '`. The elapsed intervals below run from each top-level `sql_file` or `source` call to the next top-level shell command; they include Docker/psql overhead and tracing, and are not case counts. Fresh and existing columns are the two layouts, in order. The first untraced full-run time above includes all fixtures, migrations, inline races and setup, not just the entries here. Timings are affected by browser runs in parallel.

| Suite under `tests/database/` | Fresh (s) | Existing (s) |
| --- | ---: | ---: |
| `menu-categories.sql` | 0.146 | 0.158 |
| `menu-photos.sql` | 0.095 | 0.172 |
| `owner-history.sql` | 0.098 | 0.346 |
| `menu-reorder.sql` | 0.107 | 0.200 |
| `daily-summary.sql` | 0.100 | 0.134 |
| `order-numbers.sql` | 0.123 | 0.193 |
| `saved-addresses.sql` | 0.181 | 0.428 |
| `menu-diet.sql` | 0.160 | 0.353 |
| `menu-featured.sql` | 0.084 | 0.300 |
| `restaurant-settings.sql` | 0.140 | 0.662 |
| `customer-notifications.sql` | 0.231 | 0.222 |
| `owner-display-name.sql` | 0.152 | 0.131 |
| `customer-relationships.sql` | 0.103 | 0.099 |
| `leave-business.sql` | 0.108 | 0.141 |
| `owner-login.sql` | 0.144 | 0.225 |
| `offers.sql` | 0.266 | 0.713 |
| `isolation.sql` | 0.103 | 0.334 |
| `checkout.sql` | 0.148 | 0.323 |
| `notifications.sql` | 0.128 | 0.183 |
| `notification-routing.sql` | 0.098 | 0.184 |
| `accepting-orders.sql` | 0.148 | 0.318 |
| `pricing.sql` | 0.126 | 0.240 |
| `restaurant-settings-races.sh` | 2.672 | 4.480 |
| `customer-notifications-races.sh` | 6.862 | 8.097 |
| `owner-display-name-races.sh` | 12.937 | 15.495 |
| `customer-relationships-races.sh` | 33.245 | 36.839 |
| `leave-business-races.sh` | 75.705 | 76.265 |
| `offers-races.sh` | 24.791 | 26.311 |

## Browser invocation timings

Each entry is a single invocation, timed from process start to exit with `date +%s%3N`. These are not test-case or assertion counts. The four shard sequences ran concurrently in separate loopback-only network namespaces with no external routes; each script serves the local built apps and intercepts fixture traffic. Most used system Chromium 156.0.8078.79, rather than CI’s image; photos and the separate quick-checkout measurement used Playwright 1.56.1’s Chromium 141 headless shell. All app builds used fixture configuration and completed in 161.577 seconds. Screenshots may accompany assertions; their existence alone is not counted as a case. Skip/case counts are not emitted by these scripts.

| Browser QA shard | Script under `tests/browser/` | Result | Wall time (s) |
| --- | --- | --- | ---: |
| smoke | `smoke.mjs` | passed | 593.938 |
| smoke | `quick-checkout187.mjs` | passed | 31.715 |
| cart-photos | `cart.mjs` | passed | 119.080 |
| cart-photos | `photos.mjs` | passed | 76.491 |
| cart-photos | `customer-offers182.mjs` | passed | 201.145 |
| brand-menu-kokani-checkout | `brand39.mjs` | passed | 38.982 |
| brand-menu-kokani-checkout | `menu39.mjs` | passed | 40.597 |
| brand-menu-kokani-checkout | `kokani39.mjs` | passed | 29.441 |
| brand-menu-kokani-checkout | `checkout48.mjs` | passed | 161.250 |
| inbox-leave | `cart-undo204.mjs` | passed | 50.191 |
| inbox-leave | `inbox55.mjs` | passed | 49.320 |
| inbox-leave | `leave52.mjs` | passed | 39.747 |
| inbox-leave | `otp50.mjs` | passed | 85.592 |
| inbox-leave | `owner-otp50.mjs` | passed | 42.754 |
| inbox-leave | `owner-offers182.mjs` | passed | 69.758 |
| inbox-leave | `dish-title203.mjs` | passed | 15.254 |

The first `photos.mjs` run under system Chromium failed after 5.791 seconds at line 116: an offscreen image request was observed before scrolling. A full Chromium 141 retry failed the same assertion. The 76.491-second retry above used Playwright’s CI headless shell and passed. Browser lazy-loading heuristics and browser mode affect this oracle; investigate before treating it as a product regression. The headless-shell quick checkout is a separate measurement, not an additional CI shard. The local smoke and quick-checkout measurements together exceed the workflow’s 10-minute shard timeout; different hardware, browser modes and concurrent load prevent inferring CI duration. Profile that shard in CI before deciding whether to rebalance it.
