import test from "node:test";
import assert from "node:assert/strict";
import { AgentProofService } from "../src/service.js";

const config = {
  requireSharedOS: false,
  namespaceId: "test",
  ownerId: "owner",
  purpose: "agentproof-verify-before-commit",
  maxConcurrency: 2,
  requestTimeoutMs: 500,
  turnTimeoutMs: 200,
  idempotencyTtlMs: 60_000,
  idempotencyMaxEntries: 50,
  criticProvider: "deterministic",
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  llmTimeoutMs: 100,
};

function fakeReceipt(prepared, delay = 0) {
  return new Promise((resolve) => setTimeout(() => resolve({
    verdict: "UNKNOWN",
    confidence: 0.5,
    contract: { explicit_constraints: 0, evaluated_constraints: 0, source: "inferred" },
    findings: [],
    residual_unknowns: [],
    repair: null,
    degraded: false,
    receipt: { checks_run: 1, request_id: prepared.requestId, trace_id: "fake", duration_ms: delay },
  }), delay));
}

test("same request_id and same payload is idempotent", async () => {
  let calls = 0;
  const runtime = { verifyPrepared: async (prepared) => { calls += 1; return fakeReceipt(prepared, 10); } };
  const service = await AgentProofService.create(config, { runtime });
  const input = { request_id: "same", goal: "g", candidate: "c" };
  const [a, b, c] = await Promise.all([service.verify(input), service.verify(input), service.verify(input)]);
  assert.equal(calls, 1);
  assert.equal(a.receipt.request_id, "same");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("same request_id with changed payload fails closed", async () => {
  const runtime = { verifyPrepared: (prepared) => fakeReceipt(prepared) };
  const service = await AgentProofService.create(config, { runtime });
  await service.verify({ request_id: "conflict", goal: "g", candidate: "one" });
  const b = await service.verify({ request_id: "conflict", goal: "g", candidate: "two" });
  assert.equal(b.verdict, "ERROR");
  assert.equal(b.error.code, "IDEMPOTENCY_CONFLICT");
});

test("concurrency never exceeds semaphore limit", async () => {
  let active = 0;
  let maxActive = 0;
  const runtime = {
    verifyPrepared: async (prepared) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try { return await fakeReceipt(prepared, 30); }
      finally { active -= 1; }
    },
  };
  const service = await AgentProofService.create(config, { runtime });
  await Promise.all(Array.from({ length: 8 }, (_, i) => service.verify({ request_id: `r${i}`, goal: "g", candidate: `c${i}` })));
  assert.ok(maxActive <= 2, `observed ${maxActive}`);
});

test("timeout becomes ERROR instead of hanging", async () => {
  const runtime = { verifyPrepared: async () => new Promise(() => {}) };
  const service = await AgentProofService.create({ ...config, requestTimeoutMs: 25 }, { runtime });
  const r = await service.verify({ request_id: "timeout", goal: "g", candidate: "c" });
  assert.equal(r.verdict, "ERROR");
  assert.equal(r.error.code, "TIMEOUT");
});

test("request_id namespace is isolated by caller", async () => {
  let calls = 0;
  const runtime = { verifyPrepared: async (prepared) => { calls += 1; return fakeReceipt(prepared); } };
  const service = await AgentProofService.create(config, { runtime });
  const input = { request_id: "same-across-callers", goal: "g", candidate: "c" };
  await service.verify(input, undefined, { callerAgentId: "agent-a" });
  await service.verify(input, undefined, { callerAgentId: "agent-b" });
  assert.equal(calls, 2);
});

test("transient ERROR is evicted so a retry can recover", async () => {
  let calls = 0;
  const runtime = {
    verifyPrepared: async (prepared) => {
      calls += 1;
      if (calls === 1) {
        const e = new Error("temporary");
        e.code = "TEMPORARY";
        throw e;
      }
      return fakeReceipt(prepared);
    },
  };
  const service = await AgentProofService.create(config, { runtime });
  const input = { request_id: "retryable", goal: "g", candidate: "c" };
  const a = await service.verify(input, undefined, { callerAgentId: "agent-a" });
  const b = await service.verify(input, undefined, { callerAgentId: "agent-a" });
  assert.equal(a.verdict, "ERROR");
  assert.equal(b.verdict, "UNKNOWN");
  assert.equal(calls, 2);
});

test("per-caller rate limit fails closed without affecting another caller", async () => {
  const runtime = { verifyPrepared: (prepared) => fakeReceipt(prepared) };
  const service = await AgentProofService.create({ ...config, maxCallsPerCallerPerMinute: 2 }, { runtime });
  await service.verify({ request_id: "rate-1", goal: "g", candidate: "c" }, undefined, { callerAgentId: "agent-a" });
  await service.verify({ request_id: "rate-2", goal: "g", candidate: "c" }, undefined, { callerAgentId: "agent-a" });
  const blocked = await service.verify({ request_id: "rate-3", goal: "g", candidate: "c" }, undefined, { callerAgentId: "agent-a" });
  const other = await service.verify({ request_id: "rate-4", goal: "g", candidate: "c" }, undefined, { callerAgentId: "agent-b" });
  assert.equal(blocked.error.code, "RATE_LIMITED");
  assert.equal(other.verdict, "UNKNOWN");
});

test("idempotent replay does not consume another rate-limit slot", async () => {
  let calls = 0;
  const runtime = { verifyPrepared: async (prepared) => { calls += 1; return fakeReceipt(prepared); } };
  const service = await AgentProofService.create({ ...config, maxCallsPerCallerPerMinute: 1 }, { runtime });
  const input = { request_id: "rate-idem", goal: "g", candidate: "c" };
  const first = await service.verify(input, undefined, { callerAgentId: "agent-a" });
  const replay = await service.verify(input, undefined, { callerAgentId: "agent-a" });
  const newWork = await service.verify({ request_id: "rate-new", goal: "g", candidate: "c2" }, undefined, { callerAgentId: "agent-a" });
  assert.equal(first.verdict, "UNKNOWN");
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(newWork.verdict, "ERROR");
  assert.equal(newWork.error.code, "RATE_LIMITED");
});

test("request timeout covers semaphore queue wait plus execution", async () => {
  let runtimeCalls = 0;
  const runtime = { verifyPrepared: async (prepared) => { runtimeCalls += 1; return fakeReceipt(prepared); } };
  const service = await AgentProofService.create({ ...config, maxConcurrency: 1, requestTimeoutMs: 25 }, { runtime });

  // Occupy the only permit without starting a verification. A correct end-to-end
  // deadline must expire this request while it is still in the queue.
  const release = await service.semaphore.acquire();
  try {
    const queued = await service.verify({ request_id: "queue-timeout", goal: "g", candidate: "queued" });
    assert.equal(queued.verdict, "ERROR");
    assert.equal(queued.error.code, "TIMEOUT");
    assert.equal(runtimeCalls, 0);
  } finally {
    release();
  }
});

test("idempotency cache never evicts in-flight work and duplicate execution stays one", async () => {
  let calls = 0;
  const resolvers = [];
  const runtime = {
    verifyPrepared: (prepared) => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(() => resolve({
        verdict: "UNKNOWN", confidence: 0.5,
        contract: { explicit_constraints: 0, evaluated_constraints: 0, source: "inferred" },
        findings: [], residual_unknowns: [], repair: null, degraded: false,
        receipt: { checks_run: 1, request_id: prepared.requestId, trace_id: "fake", duration_ms: 1 },
      })));
    },
  };
  const service = await AgentProofService.create({ ...config, maxConcurrency: 20, maxInflightPerCaller: 20, idempotencyMaxEntries: 10 }, { runtime });
  const pending = Array.from({ length: 11 }, (_, i) => service.verify({ request_id: `inflight-${i}`, goal: "g", candidate: `c${i}` }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const replay = service.verify({ request_id: "inflight-0", goal: "g", candidate: "c0" });
  assert.equal(calls, 11);
  for (const resolve of resolvers) resolve();
  await Promise.all([...pending, replay]);
  assert.equal(calls, 11);
});

test("error receipts preserve public request_id instead of internal caller cache key", async () => {
  const runtime = { verifyPrepared: async () => new Promise(() => {}) };
  const service = await AgentProofService.create({ ...config, requestTimeoutMs: 25 }, { runtime });
  const r = await service.verify({ request_id: "public-id", goal: "g", candidate: "c" }, undefined, { callerAgentId: "private-caller" });
  assert.equal(r.verdict, "ERROR");
  assert.equal(r.receipt.request_id, "public-id");
});

test("bounded admission rejects excess queue immediately instead of timing out later", async () => {
  const resolvers = [];
  const runtime = { verifyPrepared: (prepared) => new Promise((resolve) => resolvers.push(() => resolve({
    verdict: "UNKNOWN", confidence: 0.5,
    contract: { explicit_constraints: 0, evaluated_constraints: 0, source: "inferred" },
    findings: [], residual_unknowns: [], repair: null, degraded: false,
    receipt: { checks_run: 1, request_id: prepared.requestId, trace_id: "fake", duration_ms: 1 },
  }))) };
  const service = await AgentProofService.create({ ...config, maxConcurrency: 1, maxQueue: 1, maxInflightPerCaller: 10, requestTimeoutMs: 500 }, { runtime });
  const first = service.verify({ request_id: "load-1", goal: "g", candidate: "1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = service.verify({ request_id: "load-2", goal: "g", candidate: "2" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await service.verify({ request_id: "load-3", goal: "g", candidate: "3" });
  assert.equal(third.verdict, "ERROR");
  assert.equal(third.error.code, "OVERLOADED");
  assert.equal(service.semaphore.queued, 1);
  resolvers[0]();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolvers[1]();
  await second;
});

test("idempotency namespace includes trusted authority revision", async () => {
  let calls = 0;
  const seenGaps = [];
  const runtime = {
    verifyPrepared: async (prepared, options) => {
      calls += 1;
      seenGaps.push(options.trustedAuthorityGap?.revision ?? "none");
      return fakeReceipt(prepared);
    },
  };
  const service = await AgentProofService.create(config, { runtime });
  const input = { request_id: "authority-revision", goal: "g", candidate: "c" };

  await service.verify(input, undefined, { callerAgentId: "agent-a" });
  await service.verify(input, undefined, { callerAgentId: "agent-a" });
  await service.verify(input, undefined, {
    callerAgentId: "agent-a",
    trustedAuthorityGap: { verified: true, reason: "host denial", revision: "rev-2" },
  });
  await service.verify(input, undefined, {
    callerAgentId: "agent-a",
    trustedAuthorityGap: { verified: true, reason: "host denial", revision: "rev-2" },
  });

  assert.equal(calls, 2);
  assert.deepEqual(seenGaps, ["none", "rev-2"]);
});
