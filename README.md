# AgentProof Gate

**Independent contract verification for autonomous agents.**

AgentProof checks an agent-produced answer, action, plan, code result, or service response **before another agent trusts or executes it**. It verifies the candidate against the stated goal, explicit constraints, and caller-supplied evidence and returns a bounded, machine-readable proof receipt.

> Agents should not be the only graders of their own work.

## Arena service

- **Product:** AgentProof Gate
- **SharedNet service:** `verify_before_commit`
- **Suggested Arena price:** **5 credits**
- **Purpose:** `agentproof-verify-before-commit`
- **Product agents:** `agentproof-critic`, `agentproof-arbiter`
- **Verdicts:** `SATISFIED`, `VIOLATED`, `UNKNOWN`, `NEEDS_EVIDENCE`, `NEEDS_AUTHORITY`, `ERROR`

## Why the architecture is small

The deterministic contract checks remain host-side. Only the independent critic and arbiter execute as SharedOS-governed turns. This avoids a fragile agent swarm while making the security/audit boundary real:

```text
SharedNet call
    |
    v
Request boundary ── schema / size / caller rate limits / idempotency
    |
    v
Host deterministic contract checks
    |
    v
SharedOS Critic turn
  - read own job input
  - write own critic artifact
    |
    v
SharedOS Arbiter turn
  - read input + critic artifact
  - write final proof receipt
  - may escalate only when explicitly granted
    |
    v
Proof receipt
```

The caller never supplies grants. The request cannot expand Critic or Arbiter authority.

## Input

Minimum useful request:

```json
{
  "goal": "Book a flight costing at most $300",
  "candidate": "Book AA123 for $347"
}
```

Stronger request with an explicit contract:

```json
{
  "request_id": "flight-check-17",
  "goal": "Book an acceptable flight without exceeding the budget",
  "candidate": "Book AA123 for $347",
  "constraints": [
    "total price must be <= $300"
  ],
  "evidence": [
    {
      "id": "checkout",
      "text": "AA123 checkout total is $347",
      "provenance": "caller_supplied"
    }
  ],
  "artifact_type": "action"
}
```

`request_id` is idempotent **within one caller identity**. Reusing it with a changed payload fails closed.

## Output

```json
{
  "verdict": "VIOLATED",
  "confidence": 0.99,
  "contract": {
    "explicit_constraints": 1,
    "evaluated_constraints": 1,
    "source": "explicit"
  },
  "findings": [
    {
      "type": "constraint_violation",
      "severity": "critical",
      "rule": "total price must be <= $300",
      "observed": "$347"
    }
  ],
  "residual_unknowns": [],
  "repair": null,
  "receipt": {
    "checks_run": 2,
    "request_id": "flight-check-17",
    "trace_id": "trace-...",
    "duration_ms": 24,
    "sharedos": {
      "critic_status": "succeeded",
      "arbiter_status": "succeeded",
      "audit_events": 12
    }
  }
}
```

AgentProof deliberately does **not** return `safe_to_commit: true`. `SATISFIED` means only that the evaluated contract is satisfied within the verification scope. It is not a universal safety guarantee.

## Verification philosophy

AgentProof is asymmetric:

- an evidence-backed violation may be reported strongly;
- `SATISFIED` is intentionally difficult to earn;
- missing external-world information becomes `NEEDS_EVIDENCE` or `UNKNOWN`;
- a runtime/model failure never becomes `SATISFIED`;
- caller confidence is never evidence;
- instructions inside the candidate/evidence are untrusted data.

This minimizes the failure mode that would damage a verifier most: a false green light.

Before the critic runs, the host builds a bounded contract manifest. Only **high-confidence structured atoms** (for example an unambiguous route endpoint, directness, date, numeric limit, exact output, or safely bound action/target) are authoritative. Unsafe/free-form interpretations stay advisory and make decomposition incomplete, so they cannot independently green or red the request. Every explicit constraint is also a canonical requirement.

The critic must evaluate every canonical ID exactly once, but its label is not automatically trusted. For structured requirements, AgentProof independently derives whether the candidate/evidence actually supports `SATISFIED`, `VIOLATED`, or neither. Exact evidence quotes are validated against the referenced caller evidence. Deterministically proven explicit constraints are locked against contradictory semantic labels. Partially parsed clauses are non-decisive, and contradictory route/date/directness/mode/action statements fail safe as `UNKNOWN` instead of letting the first convenient phrase win. Missing coverage, unsupported direction, material unknowns, or high/critical unmapped concerns block `SATISFIED`.

## SharedOS grant map

Each job gets a unique job id and short-lived, exact-path grants.

| Role | Allowed | Not allowed |
|---|---|---|
| Critic | execute itself; read this job input; write this job critic artifact | final receipt write; other jobs; escalation |
| Arbiter | execute itself; read this job input + critic artifact; write this job receipt | change input; change critic artifact; other jobs |
| Arbiter (optional) | `sharedos / ["escalation"] / request` | authority expansion of any kind |

The `GrantSource` returns only grants matching the exact namespace, actor, and authority for the turn. Tool discovery is role-scoped and each invocation remains re-authorized by SharedOS.

## Resource and failure bounds

Current defaults:

- body: `64 KiB`
- goal: `4,000 chars`
- candidate: `12,000 chars`
- constraints: `20 × 500 chars`
- evidence: `10 × 2,000 chars`
- concurrent verifications: `6`
- queued verifications: `6` (additional new work fails fast with `OVERLOADED`)
- per-caller in-flight cap: `2` (one buyer cannot monopolize all workers)
- caller budget: `24 new requests / minute`
- outer verification timeout: `45s`
- SharedOS turn timeout: `18s`
- LLM critic timeout: `12s`
- LLM critic output cap: `1,200 tokens`
- organizer audit initialization timeout: `5s`
- organizer audit delivery timeout: `3s/event` with unresolved-write backpressure
- SharedNet adapter/registration initialization timeout: `8s`
- repair loops: **none** in the Arena-critical build

Idempotent replays return the cached result and do not consume a second rate-limit slot. A caller-facing timeout does **not** free the idempotency key until the underlying work actually terminates. `NEEDS_AUTHORITY` is intentionally non-sticky so a retry after a new grant opens a fresh SharedOS turn.

## Runtime requirements

- Node.js `>=20.11`
- ESM
- `@aicoo/sharedos` pinned to **`0.1.0-alpha.5`**

SharedOS is a `0.x` prerelease. The exact pin is intentional.

## Local setup

```bash
npm install
cp .env.example .env
npm test
npm run bench
npm start

# After organizer wiring is complete:
npm run check:arena
```

Health:

```bash
curl http://localhost:8787/health
```

Verify:

```bash
curl -s http://localhost:8787/verify \
  -H 'content-type: application/json' \
  -d '{
    "goal":"Keep cost within budget",
    "candidate":"Total cost is $500",
    "constraints":["cost <= $100"]
  }'
```

## Arena configuration — do this before submission

The public SharedOS docs intentionally do not publish the hackathon-specific SharedNet registration callback or organizer Cloud tenant wiring. Use the exact values/snippet provided in `#arena-support`.

Set at minimum:

```dotenv
REQUIRE_SHAREDOS=true
AGENTPROOF_NAMESPACE=<tenant/namespace supplied by organizer>
AGENTPROOF_OWNER_ADDRESS_JSON=<exact SharedOS owner address JSON supplied by organizer>
AGENTPROOF_PURPOSE=agentproof-verify-before-commit
CRITIC_PROVIDER=llm
LLM_BASE_URL=<your OpenAI-compatible endpoint>
LLM_API_KEY=<secret>
LLM_MODEL=<fast reliable model>
```

### Cloud audit adapter

`src/sharedos/runtime.js` emits SharedOS audit events through an `AuditSink`. The **committed** `arena-audit.js` file is the fail-closed organizer integration boundary. Replace only its marked organizer section with the exact `#arena-support` Cloud client/sink code and keep credentials in `.env.arena`/environment variables. Do not hard-code secrets and do not invent an endpoint.

The adapter may export either `auditSink` or `createAuditSink(...)`. Initialization is bounded, event delivery is bounded, and unresolved timed-out writes activate backpressure instead of accumulating indefinitely. Optional local NDJSON logging remains best-effort and cannot prevent the organizer sink from being attempted.

Set:

```dotenv
SHAREDOS_AUDIT_SINK_MODULE=./arena-audit.js
ORGANIZER_AUDIT_INIT_TIMEOUT_MS=5000
ORGANIZER_AUDIT_TIMEOUT_MS=3000
```

### SharedNet adapter

The exact Arena SharedNet protocol is organizer-specific, so AgentProof does not guess callback fields. The **committed** `sharednet-arena.js` file must be filled with the exact registration/call API supplied in `#arena-support`. It implements two operations:

```text
registerService({ nodeId, service, handler, signal })
callService({ nodeId, serviceName, input, callerId, signal })
```

`registerService` must register `verify_before_commit` on the organizer-issued node. Its real callback must authenticate/resolve the transport caller and call the supplied internal handler only with:

```js
{ input: organizerPayload, trustedCallerId: authenticatedTransportCaller }
```

Never derive `trustedCallerId` from the user's service payload. Generic fields such as `sender.id` or `callerNodeId` are **not trusted by AgentProof** unless the organizer adapter explicitly authenticates and maps them.

Set:

```dotenv
SHAREDNET_NODE_ID=<organizer-issued node id>
SHAREDNET_ADAPTER_MODULE=./sharednet-arena.js
SHAREDNET_INIT_TIMEOUT_MS=8000
```

The Arena server registers the service before reporting readiness. The strict Arena load test calls AgentProof **through `callService`**, not through `service.verify()` directly.

### Authority escalation

Caller text and critic opinion cannot create authority. `NEEDS_AUTHORITY` is only permitted when the host passes a trusted `authorityGap` produced from an actual authorization failure. The local code exposes that fail-closed hook; the final organizer integration must wire a real SharedOS denial into it. A caller-provided `authority_requirement` by itself never escalates.

## Final live gate

A local green test suite is not enough for hackathon eligibility. Before shipping, require all of these:

1. `npm test` shows **all SharedOS integration tests passing, no skips**.
2. `/health` reports the SharedOS runtime, not `core-fallback`.
3. One real `SATISFIED` call completes.
4. One real `VIOLATED` call completes.
5. One real `NEEDS_EVIDENCE` call never produces a false green light.
6. One **real host-observed SharedOS denial** produces a trusted authority gap and ends the Arbiter turn as `escalated`.
7. The organizer SharedOS Cloud console/audit trail shows both product agents' turns under the single purpose string.
8. A real SharedNet node can discover/call `verify_before_commit` and receive the receipt.
9. End-to-end P95 stays comfortably below the 5-minute hackathon cap; target `<25s`, hard internal cutoff `<45s`.
10. Five concurrent real calls complete without a process crash or false `SATISFIED`.
11. The submitted Git branch is pushed, has no unpushed commits, and `SUBMISSION_REPO_URL` matches `origin`.

If any optional feature threatens these gates, disable the optional feature. Reliability is the product.

## Suggested Arena listing

See [`SERVICE_LISTING.md`](./SERVICE_LISTING.md).

## Test evidence

See [`TEST_REPORT.md`](./TEST_REPORT.md) and [`ARENA_CHECKLIST.md`](./ARENA_CHECKLIST.md).

## Official references used for the integration

- https://www.sharedos.ai/docs/quickstart
- https://www.sharedos.ai/reference/sharedos
- https://www.sharedos.ai/reference/sharedos-runtime
- https://www.sharedos.ai/docs/tools
- https://www.sharedos.ai/docs/security/permission-model
- https://www.sharedos.ai/cloud
- https://www.sharedos.ai/weekly-hackathon


## Final live Arena load gate

Once organizer Cloud/SharedNet values and the real LLM are configured, run:

```bash
npm run load:arena
```

This performs real SharedNet service registration and invokes the canaries through the configured SharedNet adapter, then through AgentProof + SharedOS + organizer audit. It checks fixed `VIOLATED`, `SATISFIED`, and open-world uncertainty canaries under sequential, 5-way, and 10-way traffic and fails on any error/wrong verdict, P95 >25s, or max >45s.

## One-command Arena handoff

Only secrets and organizer-issued values belong in the uncommitted `.env.arena`. The actual organizer integration code belongs in the committed `arena-audit.js` and `sharednet-arena.js` files so judges can reproduce the path without receiving secrets.

### Windows PowerShell

```powershell
Copy-Item .env.arena.example .env.arena
# Edit .env.arena with organizer values + LLM credentials.
# Replace the marked organizer sections in arena-audit.js and sharednet-arena.js.
npm install
git add package-lock.json arena-audit.js sharednet-arena.js SERVICE_LISTING.md
git commit -m "integrate SharedOS Arena service"
git push -u origin <your-arena-branch>
npm run arena:check
npm run arena:start
```

### macOS / Linux

```bash
cp .env.arena.example .env.arena
# Edit .env.arena with organizer values + LLM credentials.
# Replace the marked organizer sections in arena-audit.js and sharednet-arena.js.
npm install
git add package-lock.json arena-audit.js sharednet-arena.js SERVICE_LISTING.md
git commit -m "integrate SharedOS Arena service"
git push -u origin main
npm run arena:check
npm run arena:start
```

`npm run arena:check` is deliberately stricter than the normal local check. It requires:

- organizer-issued namespace/tenant and exact owner address JSON;
- real LLM credentials/model;
- a bounded, loadable organizer audit adapter;
- a bounded SharedNet adapter with real `registerService` + `callService`;
- the organizer-issued SharedNet node ID;
- real `@aicoo/sharedos` and a committed `package-lock.json`;
- a clean named Git branch with `origin`, upstream, and **zero unpushed commits**;
- `SUBMISSION_REPO_URL` matching `origin`;
- the SharedNet call-syntax placeholder removed from `SERVICE_LISTING.md`;
- **zero skipped tests**;
- benchmark success;
- real SharedNet registration plus sequential/5-way/10-way live canaries within verdict/latency thresholds.

`npm run arena:start` runs the same preflight before listening, so the official Arena start path fails closed when release prerequisites are missing. Do not weaken these gates to get a green result.
