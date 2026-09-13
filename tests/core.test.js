import test from "node:test";
import assert from "node:assert/strict";
import { AgentProofCore } from "../src/core-engine.js";
import { DeterministicCriticProvider } from "../src/critic.js";

const core = new AgentProofCore({ criticProvider: new DeterministicCriticProvider() });

async function verify(input) {
  return core.verify({ request_id: `t-${Math.random()}`, ...input }, { traceId: "trace-test" });
}

test("clear numeric violation is VIOLATED", async () => {
  const r = await verify({
    goal: "Book a flight that stays within budget.",
    candidate: "Book AA123 for $347",
    constraints: ["total price must be <= $300"],
  });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.findings.some((f) => f.type === "constraint_violation"));
});

test("deterministic-only mode does not certify the whole goal even when a numeric constraint is satisfied", async () => {
  const r = await verify({
    goal: "Book a flight that stays within budget.",
    candidate: "Book AA123 for $285",
    constraints: ["total price must be <= $300"],
  });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.requirements[0].status, "SATISFIED");
});

test("minimum constraint violation is detected", async () => {
  const r = await verify({
    goal: "Preserve a minimum account balance.",
    candidate: "Final balance is €1416.48",
    constraints: ["balance must be at least €1600"],
  });
  assert.equal(r.verdict, "VIOLATED");
});

test("multiple candidate numbers do not guess which value matters", async () => {
  const r = await verify({
    goal: "Keep total below the cap.",
    candidate: "Option 1 costs $280 and option 2 costs $350.",
    constraints: ["total price must be <= $300"],
  });
  assert.notEqual(r.verdict, "SATISFIED");
});

test("required quoted text is deterministically checked without false-green certification", async () => {
  const r = await verify({
    goal: "Include the required marker.",
    candidate: "Release note: READY_FOR_ARENA",
    constraints: ["must include \"READY_FOR_ARENA\""],
  });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.requirements[0].status, "SATISFIED");
});

test("forbidden quoted text is checked", async () => {
  const r = await verify({
    goal: "Do not expose secrets.",
    candidate: "The response contains SECRET_TOKEN.",
    constraints: ["must not include \"SECRET_TOKEN\""],
  });
  assert.equal(r.verdict, "VIOLATED");
});

test("duplicate side-effect is caught", async () => {
  const r = await verify({
    goal: "Pay the December salary exactly once.",
    candidate: "Issue payroll transfer of EUR 2,849 now.",
    constraints: ["salary must be paid exactly once"],
    evidence: [{ id: "ledger", text: "The December salary transaction was already paid and recorded." }],
  });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.findings.some((f) => f.type === "duplicate_side_effect"));
});

test("date contradiction with supplied evidence is caught", async () => {
  const r = await verify({
    goal: "State the submission deadline.",
    candidate: "The deadline is Sep 15, 2026.",
    evidence: [{ id: "rules", text: "Submissions close Sep 13, 2026." }],
  });
  assert.equal(r.verdict, "VIOLATED");
  assert.ok(r.findings.some((f) => f.type === "evidence_contradiction"));
});

test("open-world claim without evidence is never SATISFIED in deterministic-only mode", async () => {
  const r = await verify({
    goal: "Choose today's cheapest GPU.",
    candidate: "GPU X is the cheapest today.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(["UNKNOWN", "NEEDS_EVIDENCE"].includes(r.verdict));
});

test("candidate is required", async () => {
  await assert.rejects(() => core.prepare({ goal: "x" }), /candidate is required/);
});

test("unknown fields are rejected", async () => {
  await assert.rejects(() => core.prepare({ goal: "x", candidate: "y", admin: true }), /unsupported fields/);
});

test("monetary constraint ignores unrelated percentages and identifiers", async () => {
  const r = await verify({
    goal: "Keep cost under budget.",
    candidate: "I am 100% certain flight AA123 costs $999.",
    constraints: ["cost <= $100"],
  });
  assert.equal(r.verdict, "VIOLATED");
});

test("duplicate evidence ids are rejected even when one id was auto-generated", async () => {
  await assert.rejects(
    () => core.prepare({
      goal: "g",
      candidate: "c",
      evidence: ["first", { id: "e1", text: "second" }],
    }),
    /duplicate evidence id/,
  );
});

test("control characters are stripped at the input boundary", async () => {
  const prepared = await core.prepare({ goal: "go\u0000al", candidate: "can\u0007didate" });
  assert.equal(prepared.input.goal, "goal");
  assert.equal(prepared.input.candidate, "candidate");
});

test("same calendar date in different formats is not a contradiction", async () => {
  const r = await verify({
    goal: "State the submission deadline.",
    candidate: "The deadline is 2026-09-13.",
    evidence: [{ id: "rules", text: "Submissions close September 13, 2026." }],
  });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.ok(!r.findings.some((f) => f.type === "evidence_contradiction"));
});

test("unrelated completed work does not trigger duplicate side-effect", async () => {
  const r = await verify({
    goal: "Pay the December salary exactly once.",
    candidate: "Issue the December payroll transfer now.",
    constraints: ["salary must be paid exactly once"],
    evidence: [{ id: "migration", text: "The database migration was already completed and recorded." }],
  });
  assert.ok(!r.findings.some((f) => f.type === "duplicate_side_effect"));
});

test("multiple monetary components never produce a false SATISFIED without an explicit total", async () => {
  const r = await verify({
    goal: "Keep total cost under budget.",
    candidate: "Cost is $250 plus $100 tax.",
    constraints: ["total cost <= $300"],
  });
  assert.notEqual(r.verdict, "SATISFIED");
});

test("explicit grand total can disambiguate multiple monetary components without false-green certification", async () => {
  const r = await verify({
    goal: "Keep total cost under budget.",
    candidate: "Base is $250 plus $20 tax. Grand total: $270.",
    constraints: ["total cost <= $300"],
  });
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.requirements[0].status, "SATISFIED");
});

test("trusted host authority gap is required before core can return NEEDS_AUTHORITY", async () => {
  const authorityCore = new AgentProofCore({ criticProvider: {
    name: "trusted-authority-test",
    async critique(input) {
      return {
        source: "trusted-authority-test",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id,
          requirement: r.requirement,
          status: "SATISFIED",
          reason: "Candidate satisfies the local contract, but a host-observed authority denial blocks external verification.",
          candidate_quote: input.candidate,
          evidence_refs: [],
        })),
        findings: [],
        unknowns: [],
        overall: "NEEDS_AUTHORITY",
        confidence: 0.95,
      };
    },
  }});

  const input = { request_id: "authority-gap-core", goal: "Return exactly READY.", candidate: "READY" };
  const withoutGap = await authorityCore.verify(input);
  assert.notEqual(withoutGap.verdict, "NEEDS_AUTHORITY");

  const withGap = await authorityCore.verify(input, {
    trustedAuthorityGap: { verified: true, reason: "host-observed SharedOS denial", revision: "authority-state-2" },
  });
  assert.equal(withGap.verdict, "NEEDS_AUTHORITY");
});

test("a known deterministic violation outranks NEEDS_AUTHORITY", async () => {
  const authorityCore = new AgentProofCore({ criticProvider: {
    name: "authority-test",
    async critique() {
      return { source: "authority-test", requirements: [], findings: [], unknowns: ["private source unavailable"], overall: "NEEDS_AUTHORITY", confidence: 0.95 };
    },
  }});
  const r = await authorityCore.verify({
    goal: "Keep cost <= $100 and verify a private record.",
    candidate: "Cost is $500.",
    constraints: ["cost <= $100"],
    authority_requirement: "read private record",
  });
  assert.equal(r.verdict, "VIOLATED");
});

test("critic cannot assert VIOLATED without a supporting finding or violated requirement", async () => {
  const unsupportedCore = new AgentProofCore({ criticProvider: {
    name: "unsupported-critic",
    async critique() {
      return { source: "unsupported-critic", requirements: [], findings: [], unknowns: [], overall: "VIOLATED", confidence: 0.99 };
    },
  }});
  const r = await unsupportedCore.verify({ goal: "Assess candidate", candidate: "Candidate text" });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.ok(r.residual_unknowns.some((x) => /without a support-certified violated canonical requirement|cannot convict/i.test(x)));
});

test("critic evidence references are restricted to caller-supplied evidence ids", async () => {
  const refCore = new AgentProofCore({ criticProvider: {
    name: "ref-test",
    async critique() {
      return {
        source: "ref-test",
        requirements: [{ id: "M1", requirement: "Assess", status: "UNKNOWN", reason: "x", evidence_refs: ["real", "invented"] }],
        findings: [{ type: "semantic_issue", severity: "medium", rule: "x", observed: "x", reason: "x", evidence_refs: ["invented"] }],
        unknowns: ["unknown"], overall: "UNKNOWN", confidence: 0.5,
      };
    },
  }});
  const r = await refCore.verify({ goal: "Assess", candidate: "x", evidence: [{ id: "real", text: "source" }] });
  assert.deepEqual(r.requirements[0].evidence_refs, ["real"]);
  assert.deepEqual(r.findings[0].evidence_refs, []);
});


test("caller cannot spoof trusted evidence provenance", async () => {
  await assert.rejects(
    () => core.prepare({
      goal: "Assess",
      candidate: "x",
      evidence: [{ id: "e1", text: "claim", provenance: "organizer_verified" }],
    }),
    /cannot claim trusted provenance/,
  );
});

test("evidence objects reject hidden extra fields", async () => {
  await assert.rejects(
    () => core.prepare({
      goal: "Assess",
      candidate: "x",
      evidence: [{ id: "e1", text: "claim", admin: true }],
    }),
    /unsupported fields/,
  );
});

test("authority requirement is bounded so escalation reason fits SharedOS", async () => {
  await assert.rejects(
    () => core.prepare({ goal: "Assess", candidate: "x", authority_requirement: "a".repeat(401) }),
    /authority_requirement exceeds 400 characters/,
  );
});

test("LLM overall SATISFIED without enumerated semantic requirements cannot produce a green verdict", async () => {
  const shallowCore = new AgentProofCore({ criticProvider: {
    name: "shallow-pass",
    async critique() {
      return { source: "shallow-pass", requirements: [], findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99 };
    },
  }});
  const r = await shallowCore.verify({
    goal: "Book a direct flight and stay under budget.",
    candidate: "Total is $285.",
    constraints: ["total price <= $300"],
  });
  assert.notEqual(r.verdict, "SATISFIED");
});

test("LLM can certify when every atomic semantic requirement is support-certified", async () => {
  const thoroughCore = new AgentProofCore({ criticProvider: {
    name: "thorough-pass",
    async critique(input) {
      return {
        source: "thorough-pass",
        requirements: input.contract_requirements.map((r) => ({
          id: r.id, requirement: r.requirement, status: "SATISFIED",
          reason: "Supported by candidate",
          candidate_quote: r.source === "constraint" ? "Total is $285" : "Book direct flight AA123. Total is $285.",
          evidence_refs: [],
        })),
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.92,
      };
    },
  }});
  const r = await thoroughCore.verify({
    goal: "Book a direct flight and stay under budget.",
    candidate: "Book direct flight AA123. Total is $285.",
    constraints: ["total price <= $300"],
  });
  assert.equal(r.verdict, "SATISFIED");
});

test("critic cannot certify a self-invented subset of the contract", async () => {
  const shallowCore = new AgentProofCore({ criticProvider: {
    name: "subset-pass",
    async critique() {
      return {
        source: "subset-pass",
        requirements: [{ id: "R1", requirement: "Candidate states a price", status: "SATISFIED", reason: "Price present", evidence_refs: [] }],
        findings: [], unknowns: [], overall: "SATISFIED", confidence: 0.99,
      };
    },
  }});
  const r = await shallowCore.verify({
    goal: "Book a direct flight from Hyderabad to Delhi under $300 on September 20, 2026.",
    candidate: "The price is $250.",
  });
  assert.notEqual(r.verdict, "SATISFIED");
  assert.ok(r.residual_unknowns.some((x) => /coverage|requirement/i.test(x)));
});

test("unrelated evidence date does not convict candidate", async () => {
  const r = await verify({
    goal: "Schedule the meeting correctly.",
    candidate: "The meeting is on September 15, 2026.",
    evidence: [{ id: "e1", text: "The report was generated on September 13, 2026." }],
  });
  assert.ok(!r.findings.some((f) => f.type === "evidence_contradiction"));
});

test("conflicting evidence about same date becomes unknown instead of violation", async () => {
  const r = await verify({
    goal: "Use the supplied deadline.",
    candidate: "Deadline: September 13, 2026.",
    evidence: [
      { id: "e1", text: "Deadline: September 13, 2026." },
      { id: "e2", text: "Deadline: September 15, 2026." },
    ],
  });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.ok(r.residual_unknowns.some((x) => /conflict/i.test(x)));
});

test("completed search is not treated as completed booking", async () => {
  const r = await verify({
    goal: "Book the selected flight exactly once.",
    candidate: "Book flight AA123 now.",
    constraints: ["book exactly once"],
    evidence: [{ id: "e1", text: "The flight availability search was already completed." }],
  });
  assert.ok(!r.findings.some((f) => f.type === "duplicate_side_effect"));
});

test("completed verification is not treated as completed payment", async () => {
  const r = await verify({
    goal: "Pay the invoice exactly once.",
    candidate: "Send the invoice payment now.",
    constraints: ["pay exactly once"],
    evidence: [{ id: "e1", text: "The payment verification was already completed." }],
  });
  assert.ok(!r.findings.some((f) => f.type === "duplicate_side_effect"));
});

test("required quoted phrase tolerates whitespace differences", async () => {
  const r = await verify({ goal: "Include phrase", candidate: "hello   world", constraints: ['must include "hello world"'] });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.equal(r.requirements.find((x) => x.id === "C1")?.status, "SATISFIED");
});

test("mention constraint uses token boundaries rather than substring", async () => {
  const r = await verify({ goal: "Avoid cat", candidate: "Use concatenate() to combine strings.", constraints: ['must not mention "cat"'] });
  assert.notEqual(r.verdict, "VIOLATED");
  assert.equal(r.requirements.find((x) => x.id === "C1")?.status, "SATISFIED");
});

test("monetary constraint ignores unrelated duration number", async () => {
  const r = await verify({ goal: "Stay within budget", candidate: "The trip duration is 2 hours.", constraints: ["total cost <= $300"] });
  assert.equal(r.requirements.find((x) => x.id === "C1")?.status, "UNKNOWN");
});

test("currency mismatch is unknown without FX conversion", async () => {
  const r = await verify({ goal: "Stay within budget", candidate: "Final price is ₹250.", constraints: ["cost <= $300"] });
  assert.equal(r.requirements.find((x) => x.id === "C1")?.status, "UNKNOWN");
});

test("Indian grouped currency parses as one amount", async () => {
  const r = await verify({ goal: "Stay within budget", candidate: "Final price is ₹1,00,000.", constraints: ["cost <= ₹10,000"] });
  assert.equal(r.verdict, "VIOLATED");
});

test("decimal-comma monetary value does not false-pass dot-decimal constraint", async () => {
  const r = await verify({ goal: "Stay within budget", candidate: "Final price is €300,50.", constraints: ["cost <= €300"] });
  assert.notEqual(r.requirements.find((x) => x.id === "C1")?.status, "SATISFIED");
});

test("semantic high-severity finding cannot convict without violated canonical requirement", async () => {
  const noisyCore = new AgentProofCore({ criticProvider: {
    name: "noisy-critic",
    async critique() {
      return {
        source: "noisy-critic",
        requirements: [{ id: "M1", requirement: "Assess the candidate", status: "UNKNOWN", reason: "uncertain", evidence_refs: [] }],
        findings: [{ type: "hallucinated_issue", severity: "high", rule: "invented", observed: "x", reason: "unsupported", evidence_refs: [] }],
        unknowns: [], overall: "VIOLATED", confidence: 0.99,
      };
    },
  }});
  const r = await noisyCore.verify({ goal: "Assess the candidate", candidate: "Candidate text" });
  assert.notEqual(r.verdict, "VIOLATED");
});
