import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerAgentProofOnSharedNet, callAgentProofThroughSharedNet } from "../src/sharednet/arena.js";

test("SharedNet Arena adapter consumes configured node ID and routes calls through registered handler", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentproof-sharednet-"));
  const modulePath = path.join(dir, "adapter.mjs");
  await fs.writeFile(modulePath, `
    let handler;
    export const sharedNetAdapter = {
      async registerService(args) {
        if (args.nodeId !== "node-real") throw new Error("wrong node");
        if (args.service.name !== "verify_before_commit") throw new Error("wrong service");
        handler = args.handler;
        return { ok: true, registrationId: "reg-1" };
      },
      async callService(args) {
        if (!handler) throw new Error("not registered");
        return handler({ input: args.input, trustedCallerId: args.callerId }, args.signal);
      }
    };
  `, "utf8");

  let seenCaller;
  const service = {
    async verify(payload, _signal, context) {
      seenCaller = context.callerAgentId;
      return { verdict: "UNKNOWN", receipt: { request_id: payload.request_id } };
    },
  };
  const config = {
    sharednetNodeId: "node-real",
    sharednetAdapterModule: modulePath,
    sharednetInitTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  };
  const registered = await registerAgentProofOnSharedNet(service, config);
  assert.equal(service.sharednetRegistered, true);
  const result = await callAgentProofThroughSharedNet(registered.adapter, config, { request_id: "r1", goal: "g", candidate: "c" }, { callerId: "buyer-7" });
  assert.equal(result.receipt.request_id, "r1");
  assert.equal(seenCaller, "buyer-7");
});
