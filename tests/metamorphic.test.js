import test from "node:test";
import assert from "node:assert/strict";
import { AgentProofCore } from "../src/core-engine.js";
import { DeterministicCriticProvider } from "../src/critic.js";

const core = new AgentProofCore({ criticProvider: new DeterministicCriticProvider() });

async function v(candidate, constraint, evidence = []) {
  return core.verify({ goal: "Validate the candidate.", candidate, constraints: [constraint], evidence });
}

test("changing only threshold flips verdict", async () => {
  const fail = await v("Total price is $347.", "price <= $300");
  const pass = await v("Total price is $347.", "price <= $400");
  assert.equal(fail.verdict, "VIOLATED");
  assert.equal(pass.verdict, "UNKNOWN");
  assert.equal(pass.requirements[0].status, "SATISFIED");
});

test("constraint paraphrase preserves verdict", async () => {
  const a = await v("Total price is $347.", "price <= $300");
  const b = await v("Total price is $347.", "price must not exceed $300");
  assert.equal(a.verdict, "VIOLATED");
  assert.equal(b.verdict, "VIOLATED");
});

test("irrelevant nonnumeric text does not change verdict", async () => {
  const a = await v("Total price is $285.", "price <= $300");
  const b = await v("Total price is $285. This paragraph is irrelevant.", "price <= $300");
  assert.equal(a.verdict, "UNKNOWN");
  assert.equal(b.verdict, "UNKNOWN");
  assert.equal(a.requirements[0].status, "SATISFIED");
  assert.equal(b.requirements[0].status, "SATISFIED");
});

test("evidence order does not change duplicate-action verdict", async () => {
  const input = {
    goal: "Pay the December salary exactly once.",
    candidate: "Send the December salary payment now.",
    constraints: ["pay exactly once"],
  };
  const e1 = { id: "a", text: "The December salary payment was already completed." };
  const e2 = { id: "b", text: "Account belongs to the intended recipient." };
  const a = await core.verify({ ...input, evidence: [e1, e2] });
  const b = await core.verify({ ...input, evidence: [e2, e1] });
  assert.equal(a.verdict, "VIOLATED");
  assert.equal(b.verdict, "VIOLATED");
});
