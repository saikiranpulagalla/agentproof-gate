import { performance } from "node:perf_hooks";
import { config } from "../src/config.js";
import { AgentProofService } from "../src/service.js";
import { registerAgentProofOnSharedNet, callAgentProofThroughSharedNet } from "../src/sharednet/arena.js";

const intEnv = (name, fallback, min = 1, max = 1000) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
};

const SEQUENTIAL = intEnv("ARENA_LOAD_SEQUENTIAL", 10, 1, 100);
const CONCURRENCY_LEVELS = (process.env.ARENA_LOAD_CONCURRENCY || "5,10")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 100);
const P95_TARGET_MS = intEnv("ARENA_LOAD_P95_TARGET_MS", 25_000, 1000, 300_000);
const MAX_TARGET_MS = intEnv("ARENA_LOAD_MAX_TARGET_MS", 45_000, 1000, 300_000);

if (!config.requireSharedOS) throw new Error("Arena load test requires REQUIRE_SHAREDOS=true");
if (config.criticProvider !== "llm") throw new Error("Arena load test requires CRITIC_PROVIDER=llm");

const service = await AgentProofService.create(config);
const sharednet = await registerAgentProofOnSharedNet(service, config);
const health = service.health();
if (!health.arena_ready) throw new Error(`service is not Arena-ready: ${JSON.stringify(health)}`);

const CASES = [
  {
    name: "deterministic-violation",
    expected: new Set(["VIOLATED"]),
    payload: {
      goal: "Keep the final total at or below $100.",
      candidate: "Final total: $500.",
      constraints: ["final total <= $100"],
    },
  },
  {
    name: "semantic-satisfied",
    expected: new Set(["SATISFIED"]),
    payload: {
      goal: "Return exactly the word READY.",
      candidate: "READY",
      constraints: ["must include \"READY\""],
    },
  },
  {
    name: "open-world-unknown",
    expected: new Set(["UNKNOWN", "NEEDS_EVIDENCE"]),
    payload: {
      goal: "Verify that Product X is the cheapest option available today.",
      candidate: "Product X is the cheapest option available today.",
    },
  },
];

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function one(index, label) {
  const testCase = CASES[index % CASES.length];
  const request_id = `arena-load-${label}-${index}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const started = performance.now();
  const result = await callAgentProofThroughSharedNet(
    sharednet.adapter,
    config,
    { ...testCase.payload, request_id },
    { callerId: `arena-load-${label}-${index}` },
  );
  const durationMs = performance.now() - started;
  return {
    case: testCase.name,
    verdict: result.verdict,
    expected: testCase.expected.has(result.verdict),
    error: result.verdict === "ERROR" ? result.error?.code ?? "ERROR" : null,
    durationMs,
    traceId: result.receipt?.trace_id ?? null,
  };
}

async function runSequential(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(await one(i, "seq"));
  return rows;
}

async function runConcurrent(count) {
  return Promise.all(Array.from({ length: count }, (_, i) => one(i, `c${count}`)));
}

function summarize(name, rows) {
  const durations = rows.map((row) => row.durationMs);
  const errors = rows.filter((row) => row.error);
  const wrongVerdicts = rows.filter((row) => !row.expected);
  return {
    name,
    calls: rows.length,
    errors: errors.length,
    wrong_verdicts: wrongVerdicts.length,
    p50_ms: Math.round(percentile(durations, 50)),
    p95_ms: Math.round(percentile(durations, 95)),
    max_ms: Math.round(Math.max(...durations)),
    error_codes: [...new Set(errors.map((row) => row.error))],
    wrong_cases: wrongVerdicts.map((row) => ({ case: row.case, verdict: row.verdict })),
  };
}

const summaries = [];
summaries.push(summarize(`sequential-${SEQUENTIAL}`, await runSequential(SEQUENTIAL)));
for (const level of CONCURRENCY_LEVELS) summaries.push(summarize(`concurrent-${level}`, await runConcurrent(level)));

const metrics = service.metricSnapshot();
const report = {
  generated_at: new Date().toISOString(),
  health,
  thresholds: { p95_ms: P95_TARGET_MS, max_ms: MAX_TARGET_MS, errors: 0, wrong_verdicts: 0 },
  summaries,
  metrics,
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
for (const summary of summaries) {
  if (summary.errors !== 0) failures.push(`${summary.name}: ${summary.errors} ERROR responses`);
  if (summary.wrong_verdicts !== 0) failures.push(`${summary.name}: ${summary.wrong_verdicts} unexpected verdicts`);
  if (summary.p95_ms > P95_TARGET_MS) failures.push(`${summary.name}: P95 ${summary.p95_ms}ms > ${P95_TARGET_MS}ms`);
  if (summary.max_ms > MAX_TARGET_MS) failures.push(`${summary.name}: max ${summary.max_ms}ms > ${MAX_TARGET_MS}ms`);
}

if (failures.length) {
  console.error("ARENA LOAD: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("ARENA LOAD: PASS");
