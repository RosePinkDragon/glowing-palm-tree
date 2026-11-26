# Bounded mutation pilot (#208)

Baseline: `cf2a9f4be5fa6ac66ba53a375ad30209c1853cca` on main; Node 24.22.3 and npm 11.19.1, Linux. This is a deliberately selected experiment, not a suite-wide mutation score. The selection follows the checkout identity, idempotency, pricing/offer, validation, and authorization risks in [the #205 inventory](test-quality-baseline-205.md). That inventory did not provide mutation evidence.

Run `node scripts/mutation-pilot-208.mjs cf2a9f4be5fa6ac66ba53a375ad30209c1853cca` from this repository. The script clones the specified commit into a fresh temporary checkout, installs only core/services workspace dependencies, runs one named test per target unmodified, runs every target with an unrelated OTP-length mutation as a negative control, then applies one mutation at a time and restores it. It deletes the checkout on normal completion and handled errors; SIGINT, SIGTERM, and abrupt termination can leave its temporary directory behind. An npm registry connection is needed for installation; no database or remote Supabase project is contacted. JSON output records baseline, control, per-mutant results and raw failure output. Anchor and test-line checks fail closed if the selected revision differs. Survivors, timeouts, uncovered tests, and setup/compile/other failures make the command exit nonzero. Treat a non-assertion/setup failure as inconclusive, not a kill.

## Results

The measured run took 17.9 seconds wall time including checkout and dependency installation on this machine. Each unmodified target and unrelated OTP control passed with exactly one test executed. Individual timings vary with machine load. The command exited 1 because one mutant survived and one result was inconclusive.

| Mutant | Invariant and selected test | Result |
| --- | --- | --- |
| `cart-subtotal` | Multiply price by quantity; [core domain test](../packages/core/src/domain.test.ts) | Assertion killed |
| `identity-generation` | Reject delayed reads after identity changes; [customer orders test](../packages/services/src/customer-orders.test.ts) | Assertion killed |
| `customer-audience` | Customer order APIs reject the admin audience; [customer orders test](../packages/services/src/customer-orders.test.ts) | Assertion killed |
| `offer-total` | Revised offer total equals subtotal plus delivery less discount; [offers test](../packages/services/src/offers.test.ts) | Assertion killed |
| `recipient-name-limit` | Reject recipient names longer than 120 characters; [core domain test](../packages/core/src/domain.test.ts) | Assertion killed |
| `checkout-key-reuse` | Preserve the caller's idempotency key; [checkout service test](../packages/services/src/index.test.ts) | **Survived**; follow-up [#242](https://github.com/RosePinkDragon/glowing-palm-tree/issues/242) is open |
| `customer-business-filter` | Scope customer order reads to the restaurant; [customer orders test](../packages/services/src/customer-orders.test.ts) | **Inconclusive**: the HTTP fixture asserted that the business filter was missing, but the SDK caught that assertion and returned a `ServiceError`. The runner cannot distinguish that wrapped fixture assertion from other setup/transport failures and does not count it as a kill. |

Seven mutants were attempted. **Five were assertion-killed, one survived, and one was inconclusive** (setup/transport-or-other failure); no timeouts, zero-test runs, or equivalent/invalid mutants were identified. Excluding the inconclusive result leaves **5 kills out of 6 evaluable mutants (83.3%)**; counting every attempt gives 5/7. Neither figure is a suite-wide score. The runner does not measure coverage, so its zero-test check is not a coverage claim. The audience mutant fails an expected-error assertion with an unauthenticated admin fixture; it does not prove the database would reject an authenticated unauthorized user.

The pilot does not mutate SQL, browser code, a real Auth server, database RLS, concurrency/races, or the actual UI checkout consumer. The identity test uses a synthetic transport; it does not prove rendered or persisted UI behavior. The idempotency survivor identifies a service-test gap, not proof that production currently sends a new key. Real database key replay and tenant guarantees remain defended separately by the database suites in #205, not by this score. Existing tests were not changed. No global threshold is justified.

A manual run is appropriate for this pilot; consider periodic CI only after measuring repeated cold and warm CI runtimes and maintenance cost. StrykerJS core 10.1.1 declares Node >=22 (registry metadata checked for this pilot), but its compatibility with this repository's native TypeScript stripping, loader, and mixed runners was not established. A small explicit harness was selected to keep this pilot bounded and its mutation and assertion evidence inspectable; this is not a conclusion about Stryker's broader suitability.
