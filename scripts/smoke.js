const base = process.env.AGENTPROOF_URL || "http://127.0.0.1:8787";
const healthResponse = await fetch(`${base}/health`);
const health = await healthResponse.json();
const deterministicOnly = health.critic === "deterministic-only";

const cases = [
  {
    name: "violation",
    expected: "VIOLATED",
    body: { request_id: `smoke-violation-${Date.now()}`, goal: "Keep cost within budget", candidate: "Total cost is $500", constraints: ["cost <= $100"] },
  },
  {
    name: "satisfied",
    expected: deterministicOnly ? "UNKNOWN" : "SATISFIED",
    body: { request_id: `smoke-satisfied-${Date.now()}`, goal: "Keep cost within budget", candidate: "Total cost is $50", constraints: ["cost <= $100"] },
  },
  {
    name: "needs-evidence",
    expectedOneOf: ["NEEDS_EVIDENCE", "UNKNOWN"],
    body: { request_id: `smoke-evidence-${Date.now()}`, goal: "Verify that this is today's cheapest GPU", candidate: "GPU X is today's cheapest GPU" },
  },
];

for (const c of cases) {
  const response = await fetch(`${base}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.body) });
  const body = await response.json();
  const ok = c.expected ? body.verdict === c.expected : c.expectedOneOf.includes(body.verdict);
  console.log(JSON.stringify({ case: c.name, ok, status: response.status, verdict: body.verdict, trace_id: body.receipt?.trace_id ?? null, duration_ms: body.receipt?.duration_ms ?? null }));
  if (!ok) process.exitCode = 1;
}
