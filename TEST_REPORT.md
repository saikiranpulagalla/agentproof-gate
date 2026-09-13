# AgentProof Gate â€” Hardened Verification Report

## Current local status

This report describes the **RC5+ SharedOS-integrated release-hardening candidate**. The real `@aicoo/sharedos@0.1.0-alpha.5` package is installed and all SharedOS integration/security tests now execute locally.

Latest local release gate after the status-aware proof and Arena-plumbing hardening:

- **122 tests discovered**
- **117 passed**
- **0 failed**
- **5 skipped** â€” only the real `@aicoo/sharedos` integration/security tests; the package cannot be installed in this container because registry access is blocked

`npm run check` is green. Latest deterministic/core benchmark (500 runs):

- P50: **0.144 ms**
- P95: **0.580 ms**
- max: **19.925 ms**

Fresh-port HTTP smoke is also green in deterministic/core-fallback mode:

- clear violation -> `VIOLATED`
- locally safe but not semantically certified -> `UNKNOWN`
- unsupported open-world claim -> `NEEDS_EVIDENCE`

These timings are core-only; real Arena latency must be measured through `npm run check:arena`, which includes the live SharedNet registration/call load gate.

## Correctness invariants enforced

### Status-aware proof direction

A critic cannot make a result green or red merely by attaching a topic-related quote. For high-confidence structured requirements, the host independently evaluates the direction of the cited/candidate text:

- route origin/destination must equal the expected values;
- numeric limits are evaluated with their actual operator/value;
- exact-output requirements are compared exactly after bounded normalization;
- direct/nonstop requirements distinguish explicit direct from connecting options;
- dated requirements require an unambiguous matching date;
- safely parsed action requirements bind the expected action and target.

A model claim that contradicts a host proof is overridden/downgraded rather than trusted. Deterministically proven explicit constraints are locked against contradictory semantic labels.

Structured evaluators also fail safe on contradictory candidate claims. Repeated conflicting route labels, mixed direct/connecting claims, multiple travel modes, conflicting anchored dates, or separate positive/negative action statements become `UNKNOWN` rather than allowing the first convenient phrase to determine the verdict.

### Safe contract parsing

Only **high-confidence structured atoms** are authoritative. Free-form or unsafe clauses remain advisory and make contract decomposition incomplete, so they cannot independently produce `SATISFIED` or `VIOLATED`.

The parser now refuses dangerous interpretations such as:

- negation becoming a positive action (`do not book` -> `must book`), including gerund forms such as `avoid booking`, `without booking`, and `refrain from booking`;
- generic `from X to Y` becoming a travel route without travel context;
- a verb being attached to an unrelated noun elsewhere in the clause.

This intentionally prefers `UNKNOWN` over manufacturing contract semantics.

### Evidence/support certificates

Evidence IDs alone are not proof. The critic must provide exact evidence quotes, the quote must occur inside the referenced caller evidence, and structured external support is direction-checked by the same host evaluator. Free-form/open-world claims remain conservative until a trusted external verification mechanism exists.

`SATISFIED` additionally requires complete authoritative coverage, no material deterministic unknown, no unresolved explicit constraint, no semantic unknown, and no unmapped high/critical concern.

### Numeric/unit safety

The deterministic numeric engine no longer compares incomparable raw numbers. Known differing units (for example hours/minutes, days/weeks, bytes/KB) and unrecognized measurement units become `UNKNOWN` unless a safe same-unit comparison exists. Percent signs at end-of-text are preserved and evaluated as percentages; unitless decimals are not silently treated as percentages.

### Exactly-once safety

A duplicate side effect requires matching action **and** sufficient target/scope identity. If the contract/candidate identifies a target but evidence omits the target, AgentProof returns uncertainty instead of a critical duplicate accusation.

### Authority safety

Caller text and critic opinion cannot trigger SharedOS escalation. `NEEDS_AUTHORITY` requires a host-supplied trusted authority gap (`verified: true`). The live organizer integration still has to create that trusted gap from an actual SharedOS denial; this is intentionally not fabricated locally.

## Distributed-system invariants

- caller-facing timeout does not free an idempotency key while underlying work is still running;
- `NEEDS_AUTHORITY` is non-sticky so a post-grant retry can open a new turn;
- in-flight entries are not evicted for cache capacity;
- per-caller in-flight cap defaults to 2;
- global concurrency and queue are bounded;
- overload fails fast instead of accepting work that is likely to miss the deadline;
- SharedNet requests require an explicitly trusted transport caller identity; guessed fields such as `sender.id` are not trusted.

## Audit hardening

- organizer audit initialization is bounded (`ORGANIZER_AUDIT_INIT_TIMEOUT_MS`, default 5s);
- organizer event delivery is bounded (`ORGANIZER_AUDIT_TIMEOUT_MS`, default 3s);
- a timed-out unresolved organizer write activates backpressure instead of allowing unbounded background writes;
- optional local NDJSON logging cannot prevent the organizer sink from being attempted;
- SharedOS `onAuditError` is surfaced.

The organizer adapter itself must honor the supplied abort signal where its SDK supports cancellation. A host cannot forcibly terminate an arbitrary third-party promise.

## SharedNet release hardening

Arena readiness is no longer a documentation/string check. The project has an explicit organizer adapter contract in `sharednet-arena.js`:

- `registerService({ nodeId, service, handler, signal })`
- `callService({ nodeId, serviceName, input, callerId, signal })`

The server registers `verify_before_commit` through this adapter before reporting Arena readiness. `npm run check:arena` runs the real live load probe through `callService`; it does not bypass SharedNet by calling `service.verify()` directly.

The organizer adapter must authenticate/resolve the real transport caller and invoke the internal handler only as `{ input, trustedCallerId }`. User payload fields never become trusted identity.

## Strict Arena release gate

`npm run check:arena` now requires all of the following before it can pass:

1. real organizer namespace and owner address JSON;
2. real LLM credentials/model;
3. commit-safe organizer audit module initializes within its deadline;
4. commit-safe SharedNet adapter exports real register/call operations;
5. organizer-issued SharedNet node ID;
6. real `@aicoo/sharedos` import;
7. committed `package-lock.json`;
8. clean Git tree;
9. public `origin` remote matching `SUBMISSION_REPO_URL`;
10. named branch with upstream and **zero unpushed commits**;
11. SharedNet call syntax placeholder removed from `SERVICE_LISTING.md`;
12. **zero skipped tests**;
13. deterministic benchmark passes;
14. real SharedNet registration + sequential/5-way/10-way live canaries pass their verdict/latency gates.

`npm run arena:start` runs preflight before starting, so an invalid Arena configuration cannot be launched through the official release command.

## Negative preflight evidence

The untouched Arena template was deliberately tested and correctly failed on the current genuine external blockers: placeholder/missing LLM values, local namespace/owner, fail-closed audit and SharedNet templates, missing SharedOS package, missing lockfile, dirty/unpublished Git state, missing public repository/upstream, and the unresolved SharedNet call syntax in `SERVICE_LISTING.md`.

## External gates still open

These cannot be truthfully completed inside this container:

1. replace the marked section in committed `arena-audit.js` with the exact organizer Cloud integration;
2. replace the marked section in committed `sharednet-arena.js` with the exact organizer SharedNet registration/call API;
3. configure organizer namespace, owner address, node ID, and real LLM in uncommitted `.env.arena`;
4. replace the `SERVICE_LISTING.md` call-syntax placeholder with the exact organizer syntax;
5. run `npm run check:arena` and obtain a live `ARENA LOAD: PASS`;
6. inspect the organizer Cloud audit and confirm Critic + Arbiter turns under the expected purpose/trace;
7. exercise a **real host-observed SharedOS authority denial -> trusted gap -> escalation** path.

Until those gates pass, the correct status is **core/release candidate hardened; Arena integration pending**, not â€œArena ready.â€
