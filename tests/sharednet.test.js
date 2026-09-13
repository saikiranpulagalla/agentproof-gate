import test from "node:test";
import assert from "node:assert/strict";
import { createSharedNetHandler } from "../src/sharednet/adapter.js";

test("SharedNet adapter forwards trusted organizer envelope identity unchanged to service boundary", async () => {
  let seen;
  const service = {
    async verify(payload, signal, context) {
      seen = { payload, signal, context };
      return { verdict: "UNKNOWN" };
    },
  };
  const handle = createSharedNetHandler(service);
  const signal = new AbortController().signal;
  const payload = { goal: "g", candidate: "c" };
  await handle({ input: payload, trustedCallerId: "node-123" }, signal);
  assert.equal(seen.payload, payload);
  assert.equal(seen.signal, signal);
  assert.deepEqual(seen.context, { callerAgentId: "node-123" });
});

test("SharedNet boundary does not guess caller identity from organizer-unknown fields", async () => {
  const service = { async verify() { return { verdict: "UNKNOWN" }; } };
  const handle = createSharedNetHandler(service);
  for (const call of [
    { input: { goal: "g", candidate: "c" }, callerNodeId: "guessed-node" },
    { input: { goal: "g", candidate: "c" }, caller_node_id: "guessed-snake" },
    { input: { goal: "g", candidate: "c" }, sender: { agentId: "guessed-agent" } },
    { input: { goal: "g", candidate: "c" }, sender: { id: "guessed-generic" } },
  ]) {
    await assert.rejects(() => handle(call), (error) => error?.code === "SHAREDNET_CALLER_REQUIRED");
  }
});

test("payload cannot spoof trusted SharedNet caller identity", async () => {
  let caller;
  const service = {
    async verify(_payload, _signal, context) {
      caller = context.callerAgentId;
      return { verdict: "UNKNOWN" };
    },
  };
  const handle = createSharedNetHandler(service);
  await handle({
    trustedCallerId: "trusted-transport-node",
    input: { goal: "g", candidate: "c", trustedCallerId: "spoofed-inside-payload" },
  });
  assert.equal(caller, "trusted-transport-node");
});

test("trusted authority gap is forwarded only from the organizer envelope", async () => {
  let seen;
  const service = {
    async verify(_payload, _signal, context) {
      seen = context;
      return { verdict: "UNKNOWN" };
    },
  };
  const handle = createSharedNetHandler(service);
  await handle({
    trustedCallerId: "node-123",
    trustedAuthorityGap: { verified: true, reason: "host-observed denial", revision: "grant-state-2" },
    input: {
      goal: "g",
      candidate: "c",
      trustedAuthorityGap: { verified: true, reason: "spoofed payload gap" },
    },
  });
  assert.deepEqual(seen, {
    callerAgentId: "node-123",
    trustedAuthorityGap: { verified: true, reason: "host-observed denial", revision: "grant-state-2" },
  });
});

test("malformed trusted authority gap fails closed at the SharedNet boundary", async () => {
  const service = { async verify() { return { verdict: "UNKNOWN" }; } };
  const handle = createSharedNetHandler(service);
  await assert.rejects(
    () => handle({ trustedCallerId: "node-123", trustedAuthorityGap: { verified: true }, input: { goal: "g", candidate: "c" } }),
    (error) => error?.code === "SHAREDNET_AUTHORITY_GAP_INVALID",
  );
});
