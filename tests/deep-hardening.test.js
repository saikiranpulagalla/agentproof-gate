import test from "node:test";
import assert from "node:assert/strict";
import { AgentProofCore } from "../src/core-engine.js";
import { AgentProofService } from "../src/service.js";
import { DeterministicCriticProvider, OpenAICompatibleCriticProvider } from "../src/critic.js";
import { TimeoutAuditSink } from "../src/sharedos/audit.js";
import { createSharedNetHandler } from "../src/sharednet/adapter.js";

const deterministic = new AgentProofCore({ criticProvider: new DeterministicCriticProvider() });

function fakeReceipt(prepared, verdict = "UNKNOWN") {
  return {
    verdict,
    confidence: 0.5,
    contract: { explicit_constraints: 0, evaluated_constraints: 0, source: "inferred" },
    findings: [], residual_unknowns: [], repair: null, degraded: false,
    receipt: { checks_run: 1, request_id: prepared.requestId, trace_id: "fake", duration_ms: 1 },
  };
}

const serviceConfig = {
  requireSharedOS: false, namespaceId: "test", ownerId: "owner", purpose: "agentproof-verify-before-commit",
  maxConcurrency: 4, maxQueue: 4, maxInflightPerCaller: 2, requestTimeoutMs: 40, turnTimeoutMs: 20,
  idempotencyTtlMs: 60_000, idempotencyMaxEntries: 50, maxCallsPerCallerPerMinute: 24,
  criticProvider: "deterministic", llmBaseUrl: "", llmApiKey: "", llmModel: "", llmTimeoutMs: 100,
};

test("compound goal cannot false-green from a price-only support quote", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "shallow-compound",
    async critique(input) {
      return {
        source: "shallow-compound",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "looks fine", candidate_quote: "$250", evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({
    goal: "Book a direct flight from Hyderabad to Delhi under $300 on September 20, 2026.",
    candidate: "The price is $250.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.contract.canonical_requirements >= 5);
  assert.ok(r.residual_unknowns.some((x) => /support certificate|UNKNOWN/i.test(x)));
});

test("open-world requirement cannot green without supplied evidence even if critic says SATISFIED", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "reckless-external",
    async critique(input) {
      return { source: "reckless-external", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "asserted", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Verify that Product X is the cheapest option available today.", candidate: "Product X is the cheapest option available today." });
  assert.equal(r.verdict, "NEEDS_EVIDENCE");
});

test("semantic VIOLATED without candidate/evidence support is downgraded and cannot convict", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "unsupported-red",
    async critique(input) {
      return { source: "unsupported-red", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "I think it is wrong", candidate_quote: "", evidence_refs: [] })), findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Return exactly the word READY.", candidate: "READY" });
  assert.notEqual(r.verdict, "VIOLATED");
});

test("material deterministic evidence conflict blocks SATISFIED even when critic overlooks it", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "conflict-blind",
    async critique(input) {
      return { source: "conflict-blind", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "candidate says it", candidate_quote: input.candidate, evidence_refs: input.evidence.map((e) => e.id) })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({
    goal: "Use the supplied deadline.", candidate: "Deadline: September 13, 2026.",
    evidence: [{ id: "e1", text: "Deadline: September 13, 2026." }, { id: "e2", text: "Deadline: September 15, 2026." }],
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.residual_unknowns.some((x) => /conflict/i.test(x)));
});

test("semantic critic can resolve a deterministic-unknown explicit constraint", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "semantic-direct",
    async critique(input) {
      return { source: "semantic-direct", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "nonstop satisfies direct", candidate_quote: "Nonstop flight AA123", evidence_refs: [] })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.95 };
    },
  }});
  const r = await core.verify({ goal: "Choose a direct flight.", candidate: "Nonstop flight AA123", constraints: ["The flight must be direct."] });
  assert.equal(r.verdict, "SATISFIED");
  assert.equal(r.contract.evaluated_constraints, 1);
});

test("high semantic finding blocks a green verdict even without a red canonical requirement", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "warning-pass",
    async critique(input) {
      return { source: "warning-pass", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "supported", candidate_quote: input.candidate, evidence_refs: [] })), findings: [{ type: "material_concern", severity: "high", rule: "review", observed: "concern", reason: "material", evidence_refs: [] }], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Return READY.", candidate: "READY" });
  assert.equal(r.verdict, "UNKNOWN");
});

test("exactly-once detector does not confuse different flight IDs", async () => {
  const r = await deterministic.verify({ goal: "Book the selected flight exactly once.", candidate: "Book flight AA123 now.", constraints: ["book exactly once"], evidence: [{ id: "e1", text: "Flight BB456 was already booked." }] });
  assert.notEqual(r.verdict, "VIOLATED");
});

test("exactly-once detector does not confuse different employer identities", async () => {
  const r = await deterministic.verify({ goal: "Pay each employee salary exactly once.", candidate: "Pay Employer A salary now.", constraints: ["pay exactly once"], evidence: [{ id: "e1", text: "Employer B salary payment was already completed." }] });
  assert.notEqual(r.verdict, "VIOLATED");
});

test("different physical units become UNKNOWN instead of a critical numeric accusation", async () => {
  const a = await deterministic.verify({ goal: "Respect duration", candidate: "Final duration: 180 minutes.", constraints: ["duration <= 3 hours"] });
  const b = await deterministic.verify({ goal: "Respect size", candidate: "Final size: 1024 KB.", constraints: ["size <= 1 MB"] });
  assert.equal(a.requirements.find((r) => r.id === "C1")?.status, "UNKNOWN");
  assert.equal(b.requirements.find((r) => r.id === "C1")?.status, "UNKNOWN");
  assert.notEqual(a.verdict, "VIOLATED");
  assert.notEqual(b.verdict, "VIOLATED");
});

test("timeout keeps idempotency key occupied until abort-ignoring work actually terminates", async () => {
  let calls = 0;
  let release;
  const runtime = { verifyPrepared: (prepared) => { calls += 1; return new Promise((resolve) => { release = () => resolve(fakeReceipt(prepared)); }); } };
  const service = await AgentProofService.create({ ...serviceConfig, requestTimeoutMs: 20 }, { runtime });
  const input = { request_id: "slow", goal: "g", candidate: "c" };
  const first = await service.verify(input, undefined, { callerAgentId: "a" });
  assert.equal(first.error.code, "TIMEOUT");
  const retryWhileAlive = await service.verify(input, undefined, { callerAgentId: "a" });
  assert.equal(retryWhileAlive.error.code, "TIMEOUT");
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // After the old work actually ends, a retry may start fresh.
  const again = service.verify(input, undefined, { callerAgentId: "a" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  release();
  await again;
});

test("NEEDS_AUTHORITY is non-sticky so retry can open a new authorized turn", async () => {
  let calls = 0;
  const runtime = { verifyPrepared: async (prepared) => { calls += 1; return fakeReceipt(prepared, "NEEDS_AUTHORITY"); } };
  const service = await AgentProofService.create(serviceConfig, { runtime });
  const input = { request_id: "authority", goal: "g", candidate: "c" };
  assert.equal((await service.verify(input, undefined, { callerAgentId: "a" })).verdict, "NEEDS_AUTHORITY");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await service.verify(input, undefined, { callerAgentId: "a" })).verdict, "NEEDS_AUTHORITY");
  assert.equal(calls, 2);
});

test("per-caller in-flight cap preserves capacity for another buyer", async () => {
  const resolvers = [];
  const runtime = { verifyPrepared: (prepared) => new Promise((resolve) => resolvers.push(() => resolve(fakeReceipt(prepared)))) };
  const service = await AgentProofService.create({ ...serviceConfig, maxConcurrency: 4, maxQueue: 4, maxInflightPerCaller: 2 }, { runtime });
  const a1 = service.verify({ request_id: "a1", goal: "g", candidate: "1" }, undefined, { callerAgentId: "A" });
  const a2 = service.verify({ request_id: "a2", goal: "g", candidate: "2" }, undefined, { callerAgentId: "A" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const a3 = await service.verify({ request_id: "a3", goal: "g", candidate: "3" }, undefined, { callerAgentId: "A" });
  const b1 = service.verify({ request_id: "b1", goal: "g", candidate: "1" }, undefined, { callerAgentId: "B" });
  assert.equal(a3.error.code, "CALLER_BUSY");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(resolvers.length >= 3);
  for (const r of resolvers) r();
  await Promise.all([a1, a2, b1]);
});

test("organizer audit sink is time bounded", async () => {
  const sink = new TimeoutAuditSink({ record: async () => new Promise(() => {}) }, 20, "organizer audit");
  await assert.rejects(() => sink.record({ id: "e" }), (error) => error?.code === "AUDIT_DELIVERY_TIMEOUT");
});

test("SharedNet boundary fails closed when trusted caller identity is missing", async () => {
  const handle = createSharedNetHandler({ verify: async () => ({ verdict: "UNKNOWN" }) });
  await assert.rejects(() => handle({ input: { goal: "g", candidate: "c" } }), (error) => error?.code === "SHAREDNET_CALLER_REQUIRED");
});

test("LLM critic is blind to deterministic verdicts", async () => {
  let payload;
  const provider = new OpenAICompatibleCriticProvider({
    baseUrl: "https://example.test/v1", apiKey: "x", model: "m", timeoutMs: 1000,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      payload = JSON.parse(body.messages[1].content);
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ requirements: [], findings: [], unknowns: ["x"], overall: "UNKNOWN", confidence: 0.5 }) } }] }; } };
    },
  });
  await provider.critique({ goal: "g", candidate: "c", constraints: [], evidence: [], artifact_type: "unknown", contract_requirements: [] }, { findings: [{ severity: "critical" }] });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "deterministic"), false);
});

test("free-form external-world requirement remains conservative even when a critic cites evidence", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "external-evidence",
    async critique(input) {
      return { source: "external-evidence", requirements: input.contract_requirements.map((r) => ({
        id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "consistent with supplied evidence",
        candidate_quote: input.candidate, evidence_refs: ["e1"],
        evidence_support: [{ id: "e1", quote: "Product X is the lowest price today." }],
      })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.95 };
    },
  }});
  const r = await core.verify({
    goal: "Verify that Product X is the cheapest option available today.",
    candidate: "Product X is the cheapest option available today.",
    evidence: [{ id: "e1", text: "Product X is the lowest price today." }],
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.equal(r.verification_scope.external_world_verified, false);
});

test("support-certified semantic violation can still produce VIOLATED", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "supported-red",
    async critique(input) {
      return { source: "supported-red", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "candidate explicitly contradicts the requirement", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.93 };
    },
  }});
  const r = await core.verify({ goal: "Return READY.", candidate: "Return NOT READY." });
  assert.equal(r.verdict, "VIOLATED");
});


test("status-aware route proof defeats a critic that labels a reversed route SATISFIED", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "reversed-route",
    async critique(input) {
      return { source: "reversed-route", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "route words are present", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Travel from Hyderabad to Delhi.", candidate: "Origin is Delhi. Destination is Hyderabad." });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.requirements.filter((x) => x.source === "goal").every((x) => x.status === "VIOLATED"));
});

test("status-aware numeric goal proof defeats an over-budget false green", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "over-budget-green",
    async critique(input) {
      return { source: "over-budget-green", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "has a price", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Choose an option under $300.", candidate: "Choose option A. Final total: $500." });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.requirements.some((x) => x.kind === "numeric" && x.status === "VIOLATED"));
});

test("critic cannot turn a host-proven exact output into a false semantic violation", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "false-red",
    async critique(input) {
      return { source: "false-red", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "wrong", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Return exactly the word READY.", candidate: "READY" });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.equal(r.requirements.find((x) => x.kind === "exact_output")?.status, "SATISFIED");
});

test("deterministic explicit satisfaction cannot be reversed by the semantic critic", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "constraint-false-red",
    async critique(input) {
      return { source: "constraint-false-red", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "claims missing", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Return READY.", candidate: "READY", constraints: ["must include \"READY\""] });
  assert.notEqual(r.verdict, "VIOLATED");
  const explicit = r.requirements.find((x) => x.source === "constraint");
  assert.equal(explicit?.status, "SATISFIED");
});

test("an evidence id without directionally supporting evidence cannot certify an external claim", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "contradictory-evidence",
    async critique(input) {
      return { source: "contradictory-evidence", requirements: input.contract_requirements.map((r) => ({
        id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "evidence cited", candidate_quote: input.candidate,
        evidence_refs: ["e1"], evidence_support: [{ id: "e1", quote: "Product Y is cheaper than Product X." }],
      })), findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await core.verify({
    goal: "Verify Product X is the cheapest option available today.",
    candidate: "Product X is the cheapest option available today.",
    evidence: [{ id: "e1", text: "Product Y is cheaper than Product X." }],
  });
  assert.notEqual(r.verdict, "SATISFIED");
});

test("goal decomposition preserves negation instead of inventing a positive action", async () => {
  const prepared = await deterministic.prepare({ goal: "Do not book a flight.", candidate: "Do not book a flight." });
  assert.equal(prepared.input.contract_requirements.some((r) => r.kind === "action" && /must book/i.test(r.requirement)), false);
  assert.equal(prepared.input.contract_requirements.some((r) => r.kind === "travel_mode"), false);
  assert.equal(prepared.input.contract_requirements.some((r) => r.kind === "forbidden_action" && /must not book/i.test(r.requirement)), true);
  assert.equal(prepared.input.contract_decomposition_complete, true);
});

test("generic from-to language is not misparsed as a travel route", async () => {
  for (const goal of ["Convert temperature from Celsius to Fahrenheit.", "Summarize pages from 10 to 20.", "Increase retries from 1 to 3."]) {
    const prepared = await deterministic.prepare({ goal, candidate: "done" });
    assert.equal(prepared.input.contract_requirements.some((r) => r.kind === "route_origin" || r.kind === "route_destination"), false);
  }
});

test("percentage unit at end-of-text is parsed without dropping the percent sign", async () => {
  const pass = await deterministic.verify({ goal: "Respect error rate", candidate: "Error rate is 5%", constraints: ["error rate <= 5%"] });
  const fail = await deterministic.verify({ goal: "Respect error rate", candidate: "Error rate is 6%", constraints: ["error rate <= 5%"] });
  const ambiguous = await deterministic.verify({ goal: "Respect error rate", candidate: "Error rate is 0.10", constraints: ["error rate <= 5%"] });
  assert.equal(pass.requirements.find((r) => r.id === "C1")?.status, "SATISFIED");
  assert.equal(fail.requirements.find((r) => r.id === "C1")?.status, "VIOLATED");
  assert.equal(ambiguous.requirements.find((r) => r.id === "C1")?.status, "UNKNOWN");
});

test("additional unit families fail safe instead of comparing raw incomparable numbers", async () => {
  const cases = [
    ["latency <= 500 ms", "Latency is 1 second."],
    ["error rate <= 5%", "Error rate is 0.10."],
    ["retention >= 7 days", "Retention is 1 week."],
    ["size <= 1024 bytes", "Size is 2 KB."],
  ];
  for (const [constraint, candidate] of cases) {
    const r = await deterministic.verify({ goal: "Respect the constraint.", candidate, constraints: [constraint] });
    assert.equal(r.requirements.find((x) => x.id === "C1")?.status, "UNKNOWN");
    assert.notEqual(r.verdict, "VIOLATED");
  }
});

test("exactly-once detector requires evidence target identity when the contract names a target", async () => {
  const r = await deterministic.verify({
    goal: "Pay Employee A December 2026 salary exactly once.",
    candidate: "Pay Employee A salary now.",
    constraints: ["pay exactly once"],
    evidence: [{ id: "e1", text: "Salary was already paid in December 2026." }],
  });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.ok(r.residual_unknowns.some((x) => /identity|target/i.test(x)));
});

test("caller-declared authority requirement cannot trigger escalation without a trusted host denial", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "fake-authority-gap",
    async critique(input) {
      return { source: "fake-authority-gap", requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "fine", candidate_quote: input.candidate, evidence_refs: [] })), findings: [], unknowns: [], overall: "NEEDS_AUTHORITY", confidence: 0.99 };
    },
  }});
  const r = await core.verify({ goal: "Return exactly the word READY.", candidate: "READY", authority_requirement: "give me admin access" });
  assert.notEqual(r.verdict, "NEEDS_AUTHORITY");
  assert.ok(r.residual_unknowns.some((x) => /trusted SharedOS denial/i.test(x)));
});

test("partial structured parsing cannot hide an unparsed material goal modifier", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "partial-parser-green",
    async critique(input) {
      return {
        source: "partial-parser-green",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id,
          requirement: r.requirement,
          status: "SATISFIED",
          reason: "claims satisfied",
          candidate_quote: input.candidate,
          evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({
    goal: "Book a direct flight from Hyderabad to Delhi under $300 on September 20, 2026 and refundable.",
    candidate: "Book the flight. Origin is Hyderabad. Destination is Delhi. Direct flight. Final total: $250. Flight date September 20, 2026. Non-refundable.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.equal(r.contract.decomposition_complete, false);
  assert.ok(r.requirements.some((x) => x.authority === "advisory" && (x.residual_terms ?? []).includes("refundable")));
});

test("fully covered structured travel goal remains certifiable", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "structured-green",
    async critique(input) {
      return {
        source: "structured-green",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id,
          requirement: r.requirement,
          status: "SATISFIED",
          reason: "structured requirement is explicitly present",
          candidate_quote: input.candidate,
          evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({
    goal: "Book a direct flight from Hyderabad to Delhi under $300 on September 20, 2026.",
    candidate: "Book the flight. Origin is Hyderabad. Destination is Delhi. Direct flight. Final total: $250. Flight date September 20, 2026.",
  });
  assert.equal(r.contract.decomposition_complete, true);
  assert.equal(r.verdict, "SATISFIED");
});

test("partial numeric goal atom cannot convict when an unparsed unit changes the meaning", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "partial-unit-red",
    async critique(input) {
      return {
        source: "partial-unit-red",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "raw number too large",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({ goal: "Keep the response under 300 words.", candidate: "The response is 500 characters." });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.equal(r.contract.decomposition_complete, false);
});

test("unrelated from-to conversion in candidate cannot create a false route violation", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "route-conversion",
    async critique(input) {
      return {
        source: "route-conversion",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "route mismatch",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({ goal: "Travel from Hyderabad to Delhi.", candidate: "Convert the fare from USD to INR before deciding." });
  assert.notEqual(r.verdict, "VIOLATED");
});

test("unrelated report date cannot create a false dated-flight violation", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "date-context",
    async critique(input) {
      return {
        source: "date-context",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "VIOLATED", reason: "date mismatch",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({
    goal: "Book a flight on September 20, 2026.",
    candidate: "Report date: September 13, 2026. Flight AA123 is being considered.",
  });
  assert.notEqual(r.verdict, "VIOLATED");
});

test("negated action language cannot satisfy a required mutating action", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "negated-action",
    async critique(input) {
      return {
        source: "negated-action",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "action words present",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({ goal: "Book a flight.", candidate: "I did not book the flight." });
  assert.equal(r.verdict, "VIOLATED");
});

test("bare numeric goal modifiers cannot disappear during decomposition", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "bare-number-green",
    async critique(input) {
      return {
        source: "bare-number-green",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "looks good",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await core.verify({ goal: "Book a flight at 8.", candidate: "Book a flight at 10." });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.equal(r.contract.decomposition_complete, false);
  assert.ok(r.requirements.some((x) => x.authority === "advisory" && (x.residual_terms ?? []).includes("#8")));
});

test("strict negated action becomes a polarity-aware structured requirement", async () => {
  const core = new AgentProofCore({ criticProvider: {
    name: "negation-aware",
    async critique(input) {
      return {
        source: "negation-aware",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "SATISFIED", reason: "critic claim",
          candidate_quote: input.candidate, evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const bad = await core.verify({ goal: "Do not book a flight.", candidate: "Book a flight." });
  assert.equal(bad.verdict, "VIOLATED");
  assert.equal(bad.contract.decomposition_complete, true);
  assert.equal(bad.requirements.some((x) => x.kind === "travel_mode"), false);
  assert.equal(bad.requirements.find((x) => x.kind === "forbidden_action")?.status, "VIOLATED");

  const good = await core.verify({ goal: "Do not book a flight.", candidate: "Do not book a flight." });
  assert.equal(good.verdict, "SATISFIED");
  assert.equal(good.requirements.find((x) => x.kind === "forbidden_action")?.status, "SATISFIED");

  const avoid = await core.verify({ goal: "Avoid booking a flight.", candidate: "Avoid booking a flight." });
  assert.equal(avoid.verdict, "SATISFIED");
  assert.equal(avoid.requirements.find((x) => x.kind === "forbidden_action")?.status, "SATISFIED");
});

function optimisticStructuredCore() {
  return new AgentProofCore({ criticProvider: {
    name: "optimistic-structured",
    async critique(input) {
      return {
        source: "optimistic-structured",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id,
          requirement: r.requirement,
          status: "SATISFIED",
          reason: "optimistic model label",
          candidate_quote: input.candidate,
          evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
}

test("conflicting repeated route labels cannot false-green", async () => {
  const core = optimisticStructuredCore();
  const r = await core.verify({
    goal: "Travel from Hyderabad to Delhi.",
    candidate: "Origin: Hyderabad. Destination: Delhi. Correction — Origin: Delhi. Destination: Hyderabad.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.requirements.some((item) => /route_origin|route_destination/.test(item.kind) && item.status === "UNKNOWN"));
});

test("conflicting direct and connecting claims cannot false-green", async () => {
  const core = optimisticStructuredCore();
  const r = await core.verify({
    goal: "Choose a direct flight.",
    candidate: "Flight AA123 is direct, but the selected itinerary is connecting with one stop.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.requirements.some((item) => item.kind === "directness" && item.status === "UNKNOWN"));
});

test("conflicting travel modes cannot false-green", async () => {
  const core = optimisticStructuredCore();
  const r = await core.verify({
    goal: "Choose a flight.",
    candidate: "Choose the flight first, then use the train instead.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.requirements.some((item) => item.kind === "travel_mode" && item.status === "UNKNOWN"));
});

test("unrelated expected date cannot hide a conflicting anchored date", async () => {
  const core = optimisticStructuredCore();
  const r = await core.verify({
    goal: "Book a flight on September 20, 2026.",
    candidate: "Report date: September 20, 2026. Flight date: September 21, 2026. Book the flight.",
  });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.requirements.some((item) => item.kind === "date" && item.status === "VIOLATED"));
});

test("conflicting positive and negative action statements become unknown", async () => {
  const core = optimisticStructuredCore();
  const r = await core.verify({
    goal: "Book a flight.",
    candidate: "I did not book the flight earlier. I will book the flight now.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.notEqual(r.verdict, "VIOLATED");
  assert.ok(r.requirements.some((item) => item.kind === "action" && item.status === "UNKNOWN"));
});

test("gerund negation forms remain polarity-aware end to end", async () => {
  const core = optimisticStructuredCore();
  for (const goal of ["Without booking a flight.", "Refrain from booking a flight."]) {
    const safe = await core.verify({ goal, candidate: "Do not book a flight." });
    assert.equal(safe.contract.decomposition_complete, true, goal);
    assert.equal(safe.verdict, "SATISFIED", goal);
    assert.equal(safe.requirements.find((item) => item.kind === "forbidden_action")?.status, "SATISFIED", goal);

    const unsafe = await core.verify({ goal, candidate: "Book a flight." });
    assert.equal(unsafe.verdict, "VIOLATED", goal);
  }
});
