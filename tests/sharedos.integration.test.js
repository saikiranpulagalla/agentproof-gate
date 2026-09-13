import test from "node:test";
import assert from "node:assert/strict";
import { AgentProofCore } from "../src/core-engine.js";
import { DeterministicCriticProvider } from "../src/critic.js";
import { SharedOSAgentProofRuntime } from "../src/sharedos/runtime.js";

const config = {
  namespaceId: "agentproof-test",
  ownerId: "owner-1",
  purpose: "agentproof-verify-before-commit",
  turnTimeoutMs: 5_000,
};

let sharedosAvailable = true;
try { await import("@aicoo/sharedos"); }
catch { sharedosAvailable = false; }

const maybe = sharedosAvailable ? test : test.skip;

maybe("SharedOS critic and arbiter expose only role-scoped tools", async () => {
  const core = new AgentProofCore({ criticProvider: new DeterministicCriticProvider() });
  const runtime = await SharedOSAgentProofRuntime.create({ core, config, enableEscalation: true });
  const prepared = await core.prepare({
    request_id: "sharedos-normal",
    goal: "Keep cost within budget.",
    candidate: "Total cost is $500.",
    constraints: ["cost <= $100"],
  });
  const r = await runtime.verifyPrepared(prepared);
  assert.equal(r.verdict, "VIOLATED");
  assert.deepEqual(new Set(r.receipt.sharedos.critic_tools), new Set(["agentproof.readInput", "agentproof.writeCritic"]));
  assert.ok(r.receipt.sharedos.arbiter_tools.includes("agentproof.readInput"));
  assert.ok(r.receipt.sharedos.arbiter_tools.includes("agentproof.readCritic"));
  assert.ok(r.receipt.sharedos.arbiter_tools.includes("agentproof.writeReceipt"));
  assert.ok(!r.receipt.sharedos.arbiter_tools.includes("agentproof.writeCritic"));
  assert.ok(r.receipt.sharedos.audit_events > 0);
});

maybe("SharedOS escalation is terminal only when the host supplies a trusted authority gap", async () => {
  const criticProvider = {
    name: "authority-test",
    async critique(input) {
      return {
        source: "authority-test",
        requirements: input.contract_requirements.map((r) => ({ id: r.id, requirement: r.requirement, status: "UNKNOWN", reason: "private repository unavailable", candidate_quote: "", evidence_refs: [] })),
        findings: [], unknowns: ["private repository unavailable"],
        overall: "NEEDS_AUTHORITY", confidence: 0.95,
      };
    },
  };
  const core = new AgentProofCore({ criticProvider });
  const runtime = await SharedOSAgentProofRuntime.create({ core, config, enableEscalation: true });
  const prepared = await core.prepare({
    request_id: "sharedos-authority",
    goal: "Verify code in a private repository.",
    candidate: "The code is safe.",
    authority_requirement: "read access to the private repository",
  });
  const withoutTrustedGap = await runtime.verifyPrepared(prepared);
  assert.notEqual(withoutTrustedGap.verdict, "NEEDS_AUTHORITY");

  const r = await runtime.verifyPrepared(prepared, { trustedAuthorityGap: { verified: true, reason: "host-observed SharedOS denial for private repository access" } });
  assert.equal(r.verdict, "NEEDS_AUTHORITY");
  assert.equal(r.receipt.sharedos.arbiter_status, "escalated");
});

maybe("SharedOS actively denies critic receipt writes and cross-job reads", async () => {
  const sharedos = await import("@aicoo/sharedos");
  const { sharedosSecurityInternals } = await import("../src/sharedos/runtime.js");
  const {
    JobStore, makeTools, jobCapability, makeGrant, makeGrantSource, TOOL_NAMESPACE,
  } = sharedosSecurityInternals;
  const { SharedOSKernel } = sharedos;

  const owner = { kind: "human", userId: "owner-1" };
  const critic = { kind: "agent", agentId: "agentproof-critic" };
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const job1 = "job-security-1";
  const job2 = "job-security-2";
  const store = new JobStore();
  store.create(job1, { goal: "g1", candidate: "c1" });
  store.create(job2, { goal: "g2", candidate: "c2" });

  const grants = [
    makeGrant({
      id: "critic-job-security",
      namespaceId: config.namespaceId,
      subject: critic,
      issuer: owner,
      capabilities: [
        jobCapability(owner, job1, "read-input"),
        jobCapability(owner, job1, "write-critic"),
      ],
      purpose: config.purpose,
      expiresAt,
      issuedAt: now,
    }),
  ];
  const kernel = new SharedOSKernel({ grantSource: makeGrantSource(grants) });
  for (const tool of makeTools(store)) kernel.registerTool(tool);
  const context = {
    namespaceId: config.namespaceId,
    actor: critic,
    authority: owner,
    owner,
    purpose: config.purpose,
    traceId: "trace-security-critic",
    enabledToolNamespaces: [TOOL_NAMESPACE],
    now,
  };
  const mkCall = (id, tool, args) => ({ id, tool, arguments: args, traceId: context.traceId, requestedAt: now });

  const allowed = await kernel.invokeTool(context, mkCall("read-own", "agentproof.readInput", { jobId: job1 }));
  assert.equal(allowed.status, "succeeded");

  const crossJob = await kernel.invokeTool(context, mkCall("read-other", "agentproof.readInput", { jobId: job2 }));
  assert.equal(crossJob.status, "denied");

  const writeReceipt = await kernel.invokeTool(context, mkCall("write-receipt", "agentproof.writeReceipt", { jobId: job1, content: { verdict: "SATISFIED" } }));
  assert.equal(writeReceipt.status, "denied");
  assert.equal(store.get(job1).receipt, null);
});

maybe("SharedOS actively denies arbiter critic writes", async () => {
  const sharedos = await import("@aicoo/sharedos");
  const { sharedosSecurityInternals } = await import("../src/sharedos/runtime.js");
  const { JobStore, makeTools, jobCapability, makeGrant, makeGrantSource, TOOL_NAMESPACE } = sharedosSecurityInternals;
  const { SharedOSKernel } = sharedos;

  const owner = { kind: "human", userId: "owner-1" };
  const arbiter = { kind: "agent", agentId: "agentproof-arbiter" };
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const jobId = "job-security-arbiter";
  const store = new JobStore();
  store.create(jobId, { goal: "g", candidate: "c" });
  store.get(jobId).critic = { source: "test" };

  const grants = [makeGrant({
    id: "arbiter-job-security",
    namespaceId: config.namespaceId,
    subject: arbiter,
    issuer: owner,
    capabilities: [
      jobCapability(owner, jobId, "read-input"),
      jobCapability(owner, jobId, "read-critic"),
      jobCapability(owner, jobId, "write-receipt"),
    ],
    purpose: config.purpose,
    expiresAt,
    issuedAt: now,
  })];
  const kernel = new SharedOSKernel({ grantSource: makeGrantSource(grants) });
  for (const tool of makeTools(store)) kernel.registerTool(tool);
  const context = {
    namespaceId: config.namespaceId,
    actor: arbiter,
    authority: owner,
    owner,
    purpose: config.purpose,
    traceId: "trace-security-arbiter",
    enabledToolNamespaces: [TOOL_NAMESPACE],
    now,
  };
  const result = await kernel.invokeTool(context, {
    id: "arbiter-write-critic",
    tool: "agentproof.writeCritic",
    arguments: { jobId, content: { forged: true } },
    traceId: context.traceId,
    requestedAt: now,
  });
  assert.equal(result.status, "denied");
  assert.deepEqual(store.get(jobId).critic, { source: "test" });
});

maybe("SharedOS denies correct job authority under wrong purpose and after expiry", async () => {
  const sharedos = await import("@aicoo/sharedos");
  const { sharedosSecurityInternals } = await import("../src/sharedos/runtime.js");
  const { JobStore, makeTools, jobCapability, makeGrant, makeGrantSource, TOOL_NAMESPACE } = sharedosSecurityInternals;
  const { SharedOSKernel } = sharedos;

  const owner = { kind: "human", userId: "owner-1" };
  const critic = { kind: "agent", agentId: "agentproof-critic" };
  const issuedAt = "2026-09-13T10:00:00.000Z";
  const expiresAt = "2026-09-13T10:05:00.000Z";
  const jobId = "job-purpose-expiry";
  const store = new JobStore();
  store.create(jobId, { goal: "g", candidate: "c" });
  const grants = [makeGrant({
    id: "purpose-expiry-grant",
    namespaceId: config.namespaceId,
    subject: critic,
    issuer: owner,
    capabilities: [jobCapability(owner, jobId, "read-input")],
    purpose: config.purpose,
    expiresAt,
    issuedAt,
  })];
  const kernel = new SharedOSKernel({ grantSource: makeGrantSource(grants) });
  for (const tool of makeTools(store)) kernel.registerTool(tool);

  const invokeAt = (purpose, now, traceId) => kernel.invokeTool({
    namespaceId: config.namespaceId,
    actor: critic,
    authority: owner,
    owner,
    purpose,
    traceId,
    enabledToolNamespaces: [TOOL_NAMESPACE],
    now,
  }, {
    id: `call-${traceId}`,
    tool: "agentproof.readInput",
    arguments: { jobId },
    traceId,
    requestedAt: now,
  });

  const wrongPurpose = await invokeAt("different-purpose", "2026-09-13T10:01:00.000Z", "trace-wrong-purpose");
  assert.equal(wrongPurpose.status, "denied");

  const expired = await invokeAt(config.purpose, "2026-09-13T10:06:00.000Z", "trace-expired");
  assert.equal(expired.status, "denied");
});
