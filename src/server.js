import http from "node:http";
import { config } from "./config.js";
import { errorReceipt, LIMITS } from "./contracts.js";
import { AgentProofService } from "./service.js";
import { registerAgentProofOnSharedNet } from "./sharednet/arena.js";

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function statusForCode(code) {
  return code === "INPUT_TOO_LARGE" ? 413
    : code === "IDEMPOTENCY_CONFLICT" ? 409
      : code === "RATE_LIMITED" ? 429
        : code === "TIMEOUT" ? 504
          : code === "INVALID_INPUT" || code === "INVALID_JSON" ? 400
            : 503;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.bodyBytes) {
      const error = new Error(`request body exceeds ${LIMITS.bodyBytes} bytes`);
      error.code = "INPUT_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const error = new Error("request body must be valid JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

export async function createAgentProofServer(serverConfig = config, overrides = {}) {
  const service = overrides.service ?? await AgentProofService.create(serverConfig, overrides);
  let sharednet = overrides.sharednet ?? null;
  if (serverConfig.requireSharedOS && !sharednet) {
    sharednet = await registerAgentProofOnSharedNet(service, serverConfig);
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, service.health());
    if (req.method === "GET" && req.url === "/metrics") return json(res, 200, service.metricSnapshot());
    if (req.method === "POST" && req.url === "/verify") {
      try {
        const body = await readJson(req);
        const result = await service.verify(body);
        return json(res, result.verdict === "ERROR" ? statusForCode(result.error?.code) : 200, result);
      } catch (error) {
        const receipt = errorReceipt(error, null);
        return json(res, statusForCode(receipt.error?.code), receipt);
      }
    }
    return json(res, 404, { error: "not_found" });
  });

  server.requestTimeout = serverConfig.requestTimeoutMs + 5_000;
  server.headersTimeout = Math.min(60_000, server.requestTimeout + 5_000);
  return { server, service, sharednet };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const { server, service } = await createAgentProofServer(config);
  server.listen(config.port, () => {
    console.log(JSON.stringify({ event: "agentproof.started", port: config.port, health: service.health() }));
  });
}
