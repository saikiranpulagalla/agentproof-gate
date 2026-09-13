import test from "node:test";
import assert from "node:assert/strict";
import { BestEffortAuditSink, CompositeAuditSink } from "../src/sharedos/audit.js";

test("composite audit attempts organizer even when another required sink fails", async () => {
  let organizerCalls = 0;
  const broken = { async record() { throw new Error("disk dead"); } };
  const organizer = { async record() { organizerCalls += 1; } };
  const sink = new CompositeAuditSink([broken, organizer]);
  await assert.rejects(() => sink.record({ id: "e1" }), /audit delivery failed/);
  assert.equal(organizerCalls, 1);
});

test("best-effort local audit never blocks organizer path", async () => {
  let warned = 0;
  let organizerCalls = 0;
  const local = new BestEffortAuditSink({ async record() { throw new Error("readonly fs"); } }, () => { warned += 1; });
  const organizer = { async record() { organizerCalls += 1; } };
  const sink = new CompositeAuditSink([organizer, local]);
  await sink.record({ id: "e2" });
  assert.equal(organizerCalls, 1);
  assert.equal(warned, 1);
});

test("timed-out organizer audit write applies backpressure until underlying write settles", async () => {
  let release;
  const sink = new (await import("../src/sharedos/audit.js")).TimeoutAuditSink({
    record: async () => new Promise((resolve) => { release = resolve; }),
  }, 20, "organizer audit", { maxOutstanding: 1 });

  await assert.rejects(() => sink.record({ id: "hung-1" }), (error) => error?.code === "AUDIT_DELIVERY_TIMEOUT");
  await assert.rejects(() => sink.record({ id: "hung-2" }), (error) => error?.code === "AUDIT_BACKPRESSURE");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("organizer audit initialization is time bounded", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { loadOrganizerAuditSink } = await import("../src/sharedos/audit.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentproof-audit-init-"));
  const modulePath = path.join(dir, "hung.mjs");
  await fs.writeFile(modulePath, "export async function createAuditSink(){ return new Promise(() => {}); }\n", "utf8");
  await assert.rejects(
    () => loadOrganizerAuditSink(modulePath, { timeoutMs: 20 }),
    (error) => error?.code === "AUDIT_INIT_TIMEOUT",
  );
});
