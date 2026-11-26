# Bounded mutation pilot (#208)

Baseline: `cf2a9f4be5fa6ac66ba53a375ad30209c1853cca` on main; Node 24.22.3 and npm 11.19.1, Linux. This is a deliberately selected experiment, not a suite-wide mutation score. The selection follows the checkout identity, pricing/offer and authorization risks in [the #205 inventory](test-quality-baseline-205.md). Its evidence is static/observational rather than previous mutation evidence.

Run `node scripts/mutation-pilot-208.mjs cf2a9f4be5fa6ac66ba53a375ad30209c1853cca` from this repository. The script clones the specified commit into a fresh temporary checkout, installs only core/services workspace dependencies, runs one named test per target unmodified, runs every target with an unrelated OTP-length mutation as a negative control, then applies one mutation at a time and restores it. It deletes the checkout on exit. An npm registry connection is needed for installation; no database or remote Supabase project is contacted. JSON output records baseline, control, per-mutant results and raw failure output. Anchor and test-line checks fail closed if the selected revision differs. Treat a timeout or non-assertion/setup failure as an inconclusive pilot, not a kill.

## Results

The measured run took 10.4 seconds wall time including checkout and workspace dependency installation on this machine. Each unmodified target and the unrelated OTP control passed with exactly one test executed. Mutant test process times were 93–176 ms. These are single local observations, not CI cost projections.

| Mutant | Invariant and defending test | Result |
| --- | --- | --- |
| `cart-subtotal` | Multiply price by quantity; [core domain test](../packages/core/src/domain.test.ts) | Assertion killed |
| `identity-generation` | Reject delayed customer reads after identity changes; [customer orders test](../packages/services/src/customer-orders.test.ts) | Assertion killed |
| `customer-audience` | Customer order APIs reject the admin audience; [customer orders test](../packages/services/src/customer-orders.test.ts) | Assertion killed |
| `offer-total` | Revised offer total must equal subtotal plus delivery less discount; [offers test](../packages/services/src/offers.test.ts) | Assertion killed |

Denominator: **4 valid, executed, selected mutants**. Assertion kills: **4/4 (100%)**; survivors: 0; timeouts: 0; setup/compile/other failures: 0; uncovered: 0 detected; equivalent/invalid: 0 identified. There are no surviving critical mutants requiring a follow-up from this run. The runner does not measure coverage, so “uncovered” here only catches a selected test that fails to execute; it is not a coverage claim. The audience mutant fails the expected error assertion with an unauthenticated admin fixture; it does not prove the database would reject an authenticated unauthorized user.

The pilot does not mutate SQL, browser code, a real Auth server, database RLS, concurrency/races, or the actual UI checkout consumer. The identity test uses a synthetic transport; it does not prove rendered or persisted UI behavior. The checkout key replay and real database pricing/tenant guarantees remain defended by the database suites in #205, not by this score. Existing tests were not changed. No global threshold is justified.

A manual run is appropriate for this four-mutant pilot; consider periodic CI only after measuring repeated cold and warm CI runtimes and maintenance cost. StrykerJS core 10.1.1 declares Node >=22 (registry metadata checked for this pilot), but its compatibility with this repository's native TypeScript stripping, loader, and mixed runners was not established. A small explicit harness was selected to keep this pilot bounded and its mutation and assertion evidence inspectable; this is not a conclusion about Stryker's broader suitability.
