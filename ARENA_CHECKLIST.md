# AgentProof Arena Release Checklist

Treat this as a hard release gate. Do not add features after the freeze unless they fix a failing P0/P1 gate.

## P0 — Eligibility / publication

- [ ] Node >=20.11 on the Arena machine
- [ ] `npm install` succeeds and `package-lock.json` is committed
- [ ] `@aicoo/sharedos` resolves to exactly `0.1.0-alpha.5`
- [ ] `REQUIRE_SHAREDOS=true`
- [ ] Exact organizer namespace/tenant configured
- [ ] Exact organizer owner address JSON configured
- [ ] Purpose is `agentproof-verify-before-commit`
- [ ] Committed `arena-audit.js` contains the real organizer Cloud integration (no secrets in code)
- [ ] Committed `sharednet-arena.js` contains the real organizer registration/call integration
- [ ] Real organizer-issued `SHAREDNET_NODE_ID` configured
- [ ] `verify_before_commit` is actually registered and callable through SharedNet
- [ ] Critic and Arbiter turns appear in organizer Cloud audit
- [ ] `SERVICE_LISTING.md` contains exact call syntax, input/output, and 5-credit price
- [ ] `origin` is the Devpost repository, branch has upstream, and local HEAD has zero unpushed commits
- [ ] `SUBMISSION_REPO_URL` matches `origin`

**Stop/rollback condition:** if any P0 item is red, do not call the submission Arena-ready.

## P1 — Correctness invariants

- [x] Structured proof direction is host-evaluated; topic overlap alone cannot green/red
- [x] Reversed route cannot be certified `SATISFIED`
- [x] Over-budget numeric goal cannot be certified `SATISFIED`
- [x] Correct exact output cannot be flipped to semantic `VIOLATED`
- [x] Deterministically proven explicit constraints cannot be reversed by critic labels
- [x] Evidence IDs alone are not proof; exact evidence quotes are validated
- [x] Unsafe/free-form decomposition is advisory and blocks green rather than inventing semantics
- [x] Partially parsed structured clauses are non-decisive; omitted qualifiers cannot false-green or false-red
- [x] Negation cannot be inverted into a positive action atom
- [x] Generic `from X to Y` is not automatically a travel route
- [x] Conflicting repeated route/date/directness/mode/action claims fail safe as `UNKNOWN`
- [x] Missing external evidence never becomes a false green locally
- [x] Contradictory supplied evidence blocks green
- [x] Different/unknown measurement units fail safe instead of raw numeric comparison
- [x] Percentage signs at end-of-text retain percentage semantics
- [x] Exactly-once duplicate accusation requires sufficient target/scope identity
- [x] Model/auth/provider failure never becomes `SATISFIED`
- [x] All locally testable `/verify` errors use the expected receipt shape

**Metric:** critical false-`SATISFIED` = **0** and critical false-`VIOLATED` = **0** on the adversarial regression corpus.

## P1 — SharedOS governance

- [ ] All 5 real SharedOS integration/security tests execute (no skips)
- [ ] Critic sees only its read-input/write-critic authority
- [ ] Arbiter sees read-input/read-critic/write-receipt
- [ ] Critic cannot write receipt or escalate
- [ ] Arbiter cannot overwrite critic artifact
- [ ] Cross-job read is denied
- [ ] Wrong-purpose access is denied
- [ ] Expired grant is denied
- [ ] One trace id groups Critic + Arbiter while execution ids remain fresh
- [x] Caller text/model opinion alone cannot produce `NEEDS_AUTHORITY`
- [ ] A **real host-observed SharedOS denial** is converted to a trusted authority gap and ends Arbiter as `escalated`

## P1 — Reliability / availability

- [x] Same caller + same request id + same payload is idempotent, including caller timeout while underlying work remains alive
- [x] Changed payload under same caller/request id -> `IDEMPOTENCY_CONFLICT`
- [x] Different callers do not collide
- [x] In-flight entries are not capacity-evicted
- [x] Transient terminal errors can be retried after underlying work ends
- [x] `NEEDS_AUTHORITY` is non-sticky
- [x] Per-caller in-flight cap prevents one buyer monopolizing capacity
- [x] Global queue is bounded and overload fails fast
- [x] Missing trusted SharedNet caller identity fails closed
- [x] Organizer audit initialization is time-bounded
- [x] Organizer audit delivery is time-bounded with unresolved-write backpressure
- [x] Optional local audit cannot starve required organizer audit
- [x] Oversized payload is rejected before model invocation
- [ ] 20 sequential live calls: 100% bounded completion
- [ ] 5 concurrent live calls: 100% bounded completion
- [ ] 10 concurrent live calls: target 100%, minimum >=90%
- [ ] Live P50 <=15s target
- [ ] Live P95 <=25s target
- [ ] Hard request max <=45s
- [ ] Process crashes = 0

## P1 — Arena conversion

- [ ] Price = 5 credits unless real market evidence justifies changing it
- [ ] Service name remains `verify_before_commit`
- [ ] Listing explains economic value before architecture
- [ ] Personal Arena agent knows the 10-second pitch
- [ ] Personal Arena agent explains input/output/price/best-use cases unaided
- [ ] Personal Arena agent never promises universal truth or safety

## Freeze sequence

Local gate:

```bash
npm run check
npm run smoke   # with the local deterministic server running
```

After real organizer code/credentials, SharedOS package, lockfile, and pushed public branch exist:

```bash
npm run check:arena
```

`check:arena` must show **zero skipped tests** and includes the real SharedNet registration/call load probe. Default live canaries are 10 sequential, 5 concurrent, and 10 concurrent with 0 errors/wrong verdicts, P95 <=25s, and max <=45s.

Then run:

```bash
npm run arena:start
```

Finally inspect organizer Cloud audit for Critic + Arbiter under the expected purpose/trace, and manually exercise the real SharedOS denial -> trusted authority gap -> `escalated` path.

## P2 — Optional only after every P0/P1 gate is green

- [ ] Repair feature
- [ ] Additional deterministic rule families
- [ ] Pretty UI
- [ ] Additional service tiers

Do not sacrifice a green P0/P1 release for P2 scope.
