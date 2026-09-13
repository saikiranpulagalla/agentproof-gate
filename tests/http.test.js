import test from "node:test";
import assert from "node:assert/strict";
import { createAgentProofServer } from "../src/server.js";

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
  maxCallsPerCallerPerMinute: 24,
  auditLogPath: "",
  organizerAuditModule: "",
  criticProvider: "deterministic",
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  llmTimeoutMs: 100,
};

async function withServer(fn) {
  const { server } = await createAgentProofServer(config);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function assertErrorShape(body) {
  assert.equal(body.verdict, "ERROR");
  assert.equal(typeof body.confidence, "number");
  assert.ok(body.contract && typeof body.contract === "object");
  assert.ok(Array.isArray(body.findings));
  assert.ok(Array.isArray(body.residual_unknowns));
  assert.ok(body.receipt && Object.hasOwn(body.receipt, "request_id"));
  assert.ok(body.error?.code);
}

test("invalid JSON returns stable receipt shape", async () => withServer(async (base) => {
  const r = await fetch(`${base}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(r.status, 400);
  assertErrorShape(await r.json());
}));

test("oversized body returns 413 and stable receipt shape", async () => withServer(async (base) => {
  const r = await fetch(`${base}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "g", candidate: "x".repeat(70_000) }) });
  assert.equal(r.status, 413);
  const body = await r.json();
  assertErrorShape(body);
  assert.equal(body.error.code, "INPUT_TOO_LARGE");
}));
