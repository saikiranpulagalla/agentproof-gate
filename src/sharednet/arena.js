import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSharedNetHandler } from "./adapter.js";

const SERVICE = Object.freeze({
  name: "verify_before_commit",
  description: "Independently verify an agent result against its goal, constraints, and supplied evidence before committing or acting.",
  price: 5,
  input: { required: ["goal", "candidate"], optional: ["request_id", "constraints", "evidence", "artifact_type", "authority_requirement"] },
  output: { verdicts: ["SATISFIED", "VIOLATED", "UNKNOWN", "NEEDS_EVIDENCE", "NEEDS_AUTHORITY", "ERROR"] },
});

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "SHAREDNET_TIMEOUT";
  return error;
}

async function bounded(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(label, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]); }
  finally { clearTimeout(timer); }
}

async function importAdapter(modulePath, timeoutMs) {
  if (!modulePath) {
    const error = new Error("SHAREDNET_ADAPTER_MODULE is required in Arena mode");
    error.code = "SHAREDNET_ADAPTER_REQUIRED";
    throw error;
  }
  const specifier = modulePath.startsWith(".") || path.isAbsolute(modulePath)
    ? pathToFileURL(path.resolve(modulePath)).href
    : modulePath;
  const mod = await bounded((signal) => import(specifier).then(async (loaded) => {
    if (loaded.sharedNetAdapter) return loaded.sharedNetAdapter;
    if (typeof loaded.createSharedNetAdapter === "function") return loaded.createSharedNetAdapter({ signal });
    return null;
  }), timeoutMs, "SharedNet adapter initialization");
  if (!mod?.registerService || !mod?.callService) {
    throw new Error("SharedNet adapter must export registerService(...) and callService(...), directly or via createSharedNetAdapter()");
  }
  return mod;
}

export async function registerAgentProofOnSharedNet(service, config) {
  if (!config.sharednetNodeId) {
    const error = new Error("SHAREDNET_NODE_ID is required in Arena mode");
    error.code = "SHAREDNET_NODE_REQUIRED";
    throw error;
  }
  const timeoutMs = config.sharednetInitTimeoutMs ?? 8_000;
  const adapter = await importAdapter(config.sharednetAdapterModule, timeoutMs);
  const internalHandler = createSharedNetHandler(service);

  const registration = await bounded((signal) => adapter.registerService({
    nodeId: config.sharednetNodeId,
    service: SERVICE,
    // Organizer adapter MUST authenticate/parse its real callback and invoke
    // this handler only with {input, trustedCallerId}.
    handler: internalHandler,
    signal,
  }), timeoutMs, "SharedNet service registration");

  if (!registration || registration.ok !== true) {
    const error = new Error("SharedNet adapter did not confirm verify_before_commit registration");
    error.code = "SHAREDNET_REGISTRATION_FAILED";
    throw error;
  }
  service.sharednetRegistered = true;
  service.sharednetNodeId = config.sharednetNodeId;
  service.sharednetRegistration = registration;
  return { adapter, registration, serviceDefinition: SERVICE };
}

export async function callAgentProofThroughSharedNet(adapter, config, input, { signal, callerId = "agentproof-live-probe" } = {}) {
  const timeoutMs = config.requestTimeoutMs ?? 45_000;
  return bounded((localSignal) => adapter.callService({
    nodeId: config.sharednetNodeId,
    serviceName: SERVICE.name,
    input,
    callerId,
    signal: signal ?? localSignal,
  }), timeoutMs, "SharedNet verify_before_commit call");
}

export { SERVICE as AGENTPROOF_SHAREDNET_SERVICE };
