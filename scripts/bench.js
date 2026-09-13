import { AgentProofCore } from "../src/core-engine.js";
import { DeterministicCriticProvider } from "../src/critic.js";

const core = new AgentProofCore({ criticProvider: new DeterministicCriticProvider() });
const N = Number(process.env.BENCH_N || 500);
const durations = [];
for (let i = 0; i < N; i += 1) {
  const start = performance.now();
  const r = await core.verify({
    request_id: `bench-${i}`,
    goal: "Keep total price within budget.",
    candidate: i % 2 ? "Total price is $285." : "Total price is $347.",
    constraints: ["price <= $300"],
  });
  const expected = i % 2 ? "UNKNOWN" : "VIOLATED";
  if (r.verdict !== expected) throw new Error(`unexpected verdict ${r.verdict}; expected ${expected}`);
  if (i % 2 && r.requirements.find((item) => item.id === "C1")?.status !== "SATISFIED") {
    throw new Error("passing numeric constraint was not deterministically satisfied");
  }
  durations.push(performance.now() - start);
}
durations.sort((a, b) => a - b);
const p = (q) => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * q))];
console.log(JSON.stringify({
  runs: N,
  p50_ms: Number(p(0.50).toFixed(3)),
  p95_ms: Number(p(0.95).toFixed(3)),
  max_ms: Number(durations.at(-1).toFixed(3)),
}, null, 2));
