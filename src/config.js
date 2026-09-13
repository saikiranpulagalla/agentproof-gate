import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // deployment environment wins over .env
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

const int = (name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
};


const choice = (name, fallback, allowed) => {
  const value = (process.env[name] || fallback).toLowerCase();
  if (!allowed.includes(value)) throw new Error(`Invalid ${name}: ${value}. Expected one of ${allowed.join(", ")}`);
  return value;
};

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`Invalid ${name}: ${raw}`);
};


function ownerAddress() {
  const raw = process.env.AGENTPROOF_OWNER_ADDRESS_JSON;
  if (!raw) return { kind: "human", userId: process.env.AGENTPROOF_OWNER_ID || "arena-owner" };
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("AGENTPROOF_OWNER_ADDRESS_JSON must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AGENTPROOF_OWNER_ADDRESS_JSON must be a SharedOS address object");
  const fields = { human: "userId", agent: "agentId", group: "conversationId", service: "serviceId" };
  const field = fields[value.kind];
  if (!field || typeof value[field] !== "string" || !value[field].trim()) {
    throw new Error("AGENTPROOF_OWNER_ADDRESS_JSON must be a valid human/agent/group/service SharedOS address");
  }
  const allowedKeys = new Set(["kind", field]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("AGENTPROOF_OWNER_ADDRESS_JSON contains unsupported address fields");
  }
  return Object.freeze({ kind: value.kind, [field]: value[field].trim() });
}

export const config = Object.freeze({
  port: int("PORT", 8787, 1, 65535),
  requireSharedOS: bool("REQUIRE_SHAREDOS", false),
  namespaceId: process.env.AGENTPROOF_NAMESPACE || "agentproof-arena",
  ownerId: process.env.AGENTPROOF_OWNER_ID || "arena-owner",
  ownerAddress: ownerAddress(),
  purpose: process.env.AGENTPROOF_PURPOSE || "agentproof-verify-before-commit",
  maxConcurrency: int("MAX_CONCURRENCY", 6, 1, 64),
  maxQueue: int("MAX_QUEUE", 6, 0, 256),
  maxInflightPerCaller: int("MAX_INFLIGHT_PER_CALLER", 2, 1, 16),
  requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 45_000, 1_000, 300_000),
  turnTimeoutMs: int("TURN_TIMEOUT_MS", 18_000, 1_000, 120_000),
  idempotencyTtlMs: int("IDEMPOTENCY_TTL_MS", 600_000, 1_000, 86_400_000),
  idempotencyMaxEntries: int("IDEMPOTENCY_MAX_ENTRIES", 500, 10, 100_000),
  maxCallsPerCallerPerMinute: int("MAX_CALLS_PER_CALLER_PER_MIN", 24, 1, 1000),
  auditLogPath: process.env.AGENTPROOF_AUDIT_LOG || "./data/audit.ndjson",
  organizerAuditModule: process.env.SHAREDOS_AUDIT_SINK_MODULE || "",
  organizerAuditTimeoutMs: int("ORGANIZER_AUDIT_TIMEOUT_MS", 3_000, 250, 30_000),
  organizerAuditInitTimeoutMs: int("ORGANIZER_AUDIT_INIT_TIMEOUT_MS", 5_000, 250, 30_000),
  sharednetNodeId: process.env.SHAREDNET_NODE_ID || "",
  sharednetAdapterModule: process.env.SHAREDNET_ADAPTER_MODULE || "",
  sharednetInitTimeoutMs: int("SHAREDNET_INIT_TIMEOUT_MS", 8_000, 500, 60_000),
  criticProvider: choice("CRITIC_PROVIDER", "auto", ["auto", "llm", "deterministic"]),
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "",
  llmTimeoutMs: int("LLM_TIMEOUT_MS", 12_000, 1_000, 60_000),
  llmMaxTokens: int("LLM_MAX_TOKENS", 1_200, 256, 4_000),
});
