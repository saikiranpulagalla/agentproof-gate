import crypto from "node:crypto";
import { nowMs, randomId, sha256 } from "../util.js";
import { BestEffortAuditSink, CompositeAuditSink, MemoryAuditSink, NdjsonAuditSink, TimeoutAuditSink, loadOrganizerAuditSink } from "./audit.js";

const JOB_NAMESPACE = "agentproof";
const TOOL_NAMESPACE = "agentproof";

const addrEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseArgsObject(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  return args;
}

function parseJobId(args) {
  const obj = parseArgsObject(args);
  if (typeof obj.jobId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(obj.jobId)) {
    throw new Error("invalid jobId");
  }
  return obj.jobId;
}

function jsonSchema(properties, required) {
  return { type: "object", additionalProperties: false, required, properties };
}

class JobStore {
  #jobs = new Map();

  create(jobId, input, trustedContext = {}) {
    if (this.#jobs.has(jobId)) throw new Error(`job already exists: ${jobId}`);
    this.#jobs.set(jobId, { input, trustedContext: structuredClone(trustedContext), critic: null, receipt: null });
  }

  get(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return job;
  }

  delete(jobId) {
    this.#jobs.delete(jobId);
  }
}


function toSharedOSJsonValue(value, path = "$") {
  if (value === null) return null;

  const type = typeof value;

  if (type === "string" || type === "boolean") return value;

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) {
        throw new TypeError(`${path}[${index}] cannot be undefined in SharedOS JSON`);
      }
      return toSharedOSJsonValue(item, `${path}[${index}]`);
    });
  }

  if (type === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }

    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // JSON objects omit undefined-valued optional properties.
      if (item === undefined) continue;
      out[key] = toSharedOSJsonValue(item, `${path}.${key}`);
    }
    return out;
  }

  throw new TypeError(`${path} contains unsupported JSON type ${type}`);
}

function makeTools(store) {
  const makeDefinition = (name, description, action, readWrite, inputSchema) => ({
    name,
    description,
    namespace: TOOL_NAMESPACE,
    source: "native",
    readWrite,
    inputSchema,
    requiredCapability: { resource: { namespace: JOB_NAMESPACE, path: ["jobs"] }, action },
    annotations: { readOnly: readWrite === "read" },
  });

  const requirement = (action) => (context, call) => ({
    resource: { namespace: JOB_NAMESPACE, path: ["jobs", parseJobId(call.arguments)], owner: context.owner },
    action,
  });

  const result = (call, output) => ({
    callId: call.id,
    tool: call.tool,
    status: "succeeded",
    output: toSharedOSJsonValue(output, `tool result ${call.tool}`),
    completedAt: new Date().toISOString(),
  });

  return [
    {
      definition: makeDefinition(
        "agentproof.readInput",
        "Read the immutable verification input for exactly one job.",
        "read-input",
        "read",
        jsonSchema({ jobId: { type: "string" } }, ["jobId"]),
      ),
      parseArguments: (args) => ({ jobId: parseJobId(args) }),
      resolveRequirement: requirement("read-input"),
      invoke: async (_context, call, signal) => {
        signal.throwIfAborted();
        const jobId = parseJobId(call.arguments);
        return result(call, { input: store.get(jobId).input });
      },
    },
    {
      definition: makeDefinition(
        "agentproof.writeCritic",
        "Write the independent critic result for exactly one job.",
        "write-critic",
        "write",
        jsonSchema({ jobId: { type: "string" }, content: {} }, ["jobId", "content"]),
      ),
      parseArguments: (args) => {
        const obj = parseArgsObject(args);
        return { jobId: parseJobId(obj), content: obj.content };
      },
      resolveRequirement: requirement("write-critic"),
      invoke: async (_context, call, signal) => {
        signal.throwIfAborted();
        const obj = parseArgsObject(call.arguments);
        const job = store.get(parseJobId(obj));
        if (job.critic !== null) throw new Error("critic result is immutable once written");
        job.critic = structuredClone(obj.content);
        return result(call, { stored: true });
      },
    },
    {
      definition: makeDefinition(
        "agentproof.readCritic",
        "Read the critic result for exactly one job.",
        "read-critic",
        "read",
        jsonSchema({ jobId: { type: "string" } }, ["jobId"]),
      ),
      parseArguments: (args) => ({ jobId: parseJobId(args) }),
      resolveRequirement: requirement("read-critic"),
      invoke: async (_context, call, signal) => {
        signal.throwIfAborted();
        const job = store.get(parseJobId(call.arguments));
        if (job.critic === null) throw new Error("critic result not available");
        return result(call, { critic: job.critic });
      },
    },
    {
      definition: makeDefinition(
        "agentproof.writeReceipt",
        "Write the final immutable proof receipt for exactly one job.",
        "write-receipt",
        "write",
        jsonSchema({ jobId: { type: "string" }, content: {} }, ["jobId", "content"]),
      ),
      parseArguments: (args) => {
        const obj = parseArgsObject(args);
        return { jobId: parseJobId(obj), content: obj.content };
      },
      resolveRequirement: requirement("write-receipt"),
      invoke: async (_context, call, signal) => {
        signal.throwIfAborted();
        const obj = parseArgsObject(call.arguments);
        const job = store.get(parseJobId(obj));
        if (job.receipt !== null) throw new Error("receipt is immutable once written");
        job.receipt = structuredClone(obj.content);
        return result(call, { stored: true });
      },
    },
  ];
}

function call(tool, args, traceId) {
  return {
    id: randomId("call"),
    tool,
    arguments: toSharedOSJsonValue(args, `tool arguments ${tool}`),
    traceId,
    requestedAt: new Date().toISOString(),
  };
}

function criticDriver(core) {
  return {
    async open(request) {
      const jobId = request.message?.payload?.jobId;
      if (typeof jobId !== "string") throw new Error("critic turn missing jobId");
      let state = 0;
      let input;
      return {
        async next(frame, signal) {
          if (state === 0) {
            state = 1;
            return { type: "tool_call", call: call("agentproof.readInput", { jobId }, request.message.traceId) };
          }
          if (state === 1) {
            if (frame.type !== "tool_result" || frame.result.status !== "succeeded") {
              return { type: "fail", error: { code: "INPUT_READ_FAILED", message: "Critic could not read its job input", retryable: false } };
            }
            input = frame.result.output?.input;
            const content = await core.critique(input, signal);
            state = 2;
            return { type: "tool_call", call: call("agentproof.writeCritic", { jobId, content }, request.message.traceId) };
          }
          if (state === 2) {
            if (frame.type !== "tool_result" || frame.result.status !== "succeeded") {
              return { type: "fail", error: { code: "CRITIC_WRITE_FAILED", message: "Critic result could not be persisted", retryable: false } };
            }
            state = 3;
            return { type: "complete", output: { jobId, criticWritten: true } };
          }
          return { type: "fail", error: { code: "INVALID_CRITIC_STATE", message: "Critic driver advanced past terminal state", retryable: false } };
        },
      };
    },
  };
}

function arbiterDriver(core, store, { enableEscalation = true } = {}) {
  return {
    async open(request) {
      const jobId = request.message?.payload?.jobId;
      if (typeof jobId !== "string") throw new Error("arbiter turn missing jobId");
      let state = 0;
      let input;
      let critique;
      let receipt;
      const visible = new Set((request.tools ?? []).map((tool) => tool.name));
      return {
        async next(frame) {
          if (state === 0) {
            state = 1;
            return { type: "tool_call", call: call("agentproof.readInput", { jobId }, request.message.traceId) };
          }
          if (state === 1) {
            if (frame.type !== "tool_result" || frame.result.status !== "succeeded") {
              return { type: "fail", error: { code: "INPUT_READ_FAILED", message: "Arbiter could not read its job input", retryable: false } };
            }
            input = frame.result.output?.input;
            state = 2;
            return { type: "tool_call", call: call("agentproof.readCritic", { jobId }, request.message.traceId) };
          }
          if (state === 2) {
            if (frame.type !== "tool_result" || frame.result.status !== "succeeded") {
              return { type: "fail", error: { code: "CRITIC_READ_FAILED", message: "Arbiter could not read critic output", retryable: false } };
            }
            critique = frame.result.output?.critic;
            const trustedContext = store.get(jobId).trustedContext ?? {};
            receipt = core.arbitrate(input, critique?.deterministic ?? {}, critique?.critic ?? {}, trustedContext);
            state = 3;
            return { type: "tool_call", call: call("agentproof.writeReceipt", { jobId, content: receipt }, request.message.traceId) };
          }
          if (state === 3) {
            if (frame.type !== "tool_result" || frame.result.status !== "succeeded") {
              return { type: "fail", error: { code: "RECEIPT_WRITE_FAILED", message: "Arbiter receipt could not be persisted", retryable: false } };
            }
            state = 4;
            if (enableEscalation && receipt?.verdict === "NEEDS_AUTHORITY" && visible.has("sharedos.escalate")) {
              const gap = store.get(jobId).trustedContext?.authorityGap;
              const reason = `AgentProof needs additional authority to verify: ${gap?.reason ?? "trusted host authorization denial"}`.slice(0, 512);
              return { type: "escalate", reason };
            }
            return { type: "complete", output: { jobId, verdict: receipt?.verdict ?? "UNKNOWN" } };
          }
          return { type: "fail", error: { code: "INVALID_ARBITER_STATE", message: "Arbiter driver advanced past terminal state", retryable: false } };
        },
      };
    },
  };
}

function jobCapability(owner, jobId, action) {
  return {
    resource: { namespace: JOB_NAMESPACE, path: ["jobs", jobId], owner },
    actions: [action],
    scope: "exact",
  };
}

function makeGrant({ id, namespaceId, subject, issuer, capabilities, purpose, expiresAt, issuedAt }) {
  return {
    id,
    namespaceId,
    subject,
    issuer,
    capabilities,
    constraints: { purposes: [purpose], expiresAt },
    issuedAt,
  };
}

function makeGrantSource(grants) {
  return {
    async load(context) {
      return grants.filter((grant) =>
        grant.namespaceId === context.namespaceId
        && addrEq(grant.subject, context.actor)
        && addrEq(grant.issuer, context.authority));
    },
  };
}

/**
 * Narrow test/conformance hooks. These are the exact builders the production
 * runtime uses, exported so integration tests can attack the same grant/tool
 * topology instead of maintaining a duplicate security model.
 */
export const sharedosSecurityInternals = Object.freeze({
  JOB_NAMESPACE,
  TOOL_NAMESPACE,
  JobStore,
  makeTools,
  jobCapability,
  makeGrant,
  makeGrantSource,
});

export class SharedOSAgentProofRuntime {
  constructor({ core, config, sharedos, organizerAuditSink = null, enableEscalation = true }) {
    this.core = core;
    this.config = config;
    this.sharedos = sharedos;
    this.organizerAuditSink = organizerAuditSink;
    this.enableEscalation = enableEscalation;
    this.organizerAuditConfigured = Boolean(organizerAuditSink);
    this.store = new JobStore();
  }

  static async create({ core, config, enableEscalation = true }) {
    const sharedos = await import("@aicoo/sharedos");
    if (config.requireSharedOS && !config.organizerAuditModule) {
      const error = new Error("REQUIRE_SHAREDOS=true requires SHAREDOS_AUDIT_SINK_MODULE so organizer audit cannot be silently omitted");
      error.code = "ORGANIZER_AUDIT_REQUIRED";
      throw error;
    }
    // Fail at startup, not on the first Arena request, if the configured Cloud/audit adapter is broken.
    const rawOrganizerAuditSink = await loadOrganizerAuditSink(config.organizerAuditModule, { timeoutMs: config.organizerAuditInitTimeoutMs ?? 5_000 });
    const organizerAuditSink = rawOrganizerAuditSink
      ? new TimeoutAuditSink(rawOrganizerAuditSink, config.organizerAuditTimeoutMs ?? 3_000, "organizer audit")
      : null;
    return new SharedOSAgentProofRuntime({ core, config, sharedos, organizerAuditSink, enableEscalation });
  }

  async verifyPrepared({ input, requestId }, { signal, callerAgentId = "sharednet-caller", trustedAuthorityGap = null } = {}) {
    const started = nowMs();
    const traceId = randomId("trace");
    const callerHash = sha256(String(callerAgentId)).slice(0, 24);
    const requestHash = sha256(String(requestId)).slice(0, 24);
    const jobId = `job-${callerHash}-${requestHash}-${crypto.randomUUID().slice(0, 8)}`;
    const trustedContext = trustedAuthorityGap?.verified === true
      ? { authorityGap: structuredClone(trustedAuthorityGap) }
      : {};
    this.store.create(jobId, input, trustedContext);

    const {
      SharedOSKernel,
      SharedOSExecutor,
      StandardRuntime,
      agentExecutionCapability,
      createEscalationTool,
    } = this.sharedos;

    const owner = this.config.ownerAddress ?? { kind: "human", userId: this.config.ownerId };
    const caller = { kind: "agent", agentId: `sharednet-${callerHash}` };
    const critic = { kind: "agent", agentId: "agentproof-critic" };
    const arbiter = { kind: "agent", agentId: "agentproof-arbiter" };
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

    const grants = [
      makeGrant({
        id: `g-${jobId}-critic-exec`, namespaceId: this.config.namespaceId, subject: critic, issuer: owner,
        capabilities: [agentExecutionCapability(critic, owner)], purpose: this.config.purpose, expiresAt, issuedAt: now,
      }),
      makeGrant({
        id: `g-${jobId}-critic-job`, namespaceId: this.config.namespaceId, subject: critic, issuer: owner,
        capabilities: [jobCapability(owner, jobId, "read-input"), jobCapability(owner, jobId, "write-critic")],
        purpose: this.config.purpose, expiresAt, issuedAt: now,
      }),
      makeGrant({
        id: `g-${jobId}-arbiter-exec`, namespaceId: this.config.namespaceId, subject: arbiter, issuer: owner,
        capabilities: [agentExecutionCapability(arbiter, owner)], purpose: this.config.purpose, expiresAt, issuedAt: now,
      }),
      makeGrant({
        id: `g-${jobId}-arbiter-job`, namespaceId: this.config.namespaceId, subject: arbiter, issuer: owner,
        capabilities: [
          jobCapability(owner, jobId, "read-input"),
          jobCapability(owner, jobId, "read-critic"),
          jobCapability(owner, jobId, "write-receipt"),
        ], purpose: this.config.purpose, expiresAt, issuedAt: now,
      }),
    ];

    if (this.enableEscalation) {
      grants.push(makeGrant({
        id: `g-${jobId}-arbiter-escalate`, namespaceId: this.config.namespaceId, subject: arbiter, issuer: owner,
        capabilities: [{
          resource: { namespace: "sharedos", path: ["escalation"], owner },
          actions: ["request"],
          scope: "exact",
        }], purpose: this.config.purpose, expiresAt, issuedAt: now,
      }));
    }

    const audit = [];
    const auditErrors = [];
    const auditWarnings = [];
    const memoryAudit = new MemoryAuditSink(audit);
    const fileAudit = this.config.auditLogPath
      ? new BestEffortAuditSink(new NdjsonAuditSink(this.config.auditLogPath), (error) => {
          auditWarnings.push(error instanceof Error ? error.message : String(error));
        })
      : null;
    const kernel = new SharedOSKernel({
      grantSource: makeGrantSource(grants),
      // Organizer audit is a required sink when configured. Local NDJSON is
      // diagnostic only and is wrapped best-effort so disk problems cannot
      // starve organizer delivery.
      audit: new CompositeAuditSink([memoryAudit, this.organizerAuditSink, fileAudit]),
      onAuditError: async (error, event) => {
        auditErrors.push({
          message: error instanceof Error ? error.message : String(error),
          eventId: event?.id ?? null,
          type: event?.type ?? null,
        });
      },
    });
    for (const tool of makeTools(this.store)) kernel.registerTool(tool);
    if (this.enableEscalation) kernel.registerTool(createEscalationTool());

    const baseContext = (actor, enabledToolNamespaces) => ({
      namespaceId: this.config.namespaceId,
      actor,
      authority: owner,
      owner,
      purpose: this.config.purpose,
      traceId,
      enabledToolNamespaces,
      now: new Date().toISOString(),
    });

    const executeRole = async (actor, driver, enabledToolNamespaces, suffix) => {
      const context = baseContext(actor, enabledToolNamespaces);
      const tools = await kernel.listTools(context);
      const request = {
        version: "1",
        executionId: `${jobId}-${suffix}-${crypto.randomUUID()}`,
        agent: actor,
        context,
        message: {
          version: "1",
          id: `${jobId}-${suffix}-message-${crypto.randomUUID()}`,
          sender: caller,
          receiver: actor,
          purpose: context.purpose,
          payload: { jobId },
          traceId,
          createdAt: context.now,
        },
        tools: [...tools],
      };
      const executor = new SharedOSExecutor(kernel, new StandardRuntime(driver), {
        defaultMaxSteps: 8,
        defaultMaxToolCalls: 6,
        defaultTimeoutMs: this.config.turnTimeoutMs,
      });
      return { result: await executor.execute(request, signal ? { signal } : undefined), tools };
    };

    try {
      const criticTurn = await executeRole(critic, criticDriver(this.core), [TOOL_NAMESPACE], "critic");
      if (criticTurn.result.status !== "succeeded") {
        const error = new Error(`critic SharedOS turn ended ${criticTurn.result.status}`);
        error.code = "CRITIC_TURN_FAILED";
        error.turn = criticTurn.result;
        throw error;
      }
      if (auditErrors.length) {
        const error = new Error(`required audit delivery failed during critic turn: ${auditErrors[0].message}`);
        error.code = "AUDIT_DELIVERY_FAILED";
        error.auditErrors = auditErrors;
        throw error;
      }

      const arbiterTurn = await executeRole(
        arbiter,
        arbiterDriver(this.core, this.store, { enableEscalation: this.enableEscalation }),
        this.enableEscalation ? [TOOL_NAMESPACE, "sharedos"] : [TOOL_NAMESPACE],
        "arbiter",
      );

      const job = this.store.get(jobId);
      if (!job.receipt) {
        const error = new Error(`arbiter did not produce receipt; status=${arbiterTurn.result.status}`);
        error.code = "ARBITER_NO_RECEIPT";
        throw error;
      }
      const expectedArbiterStatus = this.enableEscalation && job.receipt.verdict === "NEEDS_AUTHORITY"
        ? "escalated"
        : "succeeded";
      if (arbiterTurn.result.status !== expectedArbiterStatus) {
        const error = new Error(`arbiter SharedOS turn ended ${arbiterTurn.result.status}; expected ${expectedArbiterStatus} for verdict ${job.receipt.verdict}`);
        error.code = "ARBITER_TURN_FAILED";
        error.turn = arbiterTurn.result;
        throw error;
      }
      if (auditErrors.length) {
        const error = new Error(`required audit delivery failed during arbiter turn: ${auditErrors[0].message}`);
        error.code = "AUDIT_DELIVERY_FAILED";
        error.auditErrors = auditErrors;
        throw error;
      }

      return {
        ...job.receipt,
        receipt: {
          checks_run: (job.critic?.deterministic?.checks_run ?? 0) + 1,
          request_id: requestId,
          trace_id: traceId,
          duration_ms: Math.round(nowMs() - started),
          critic: job.critic?.critic?.source ?? "unknown",
          sharedos: {
            critic_status: criticTurn.result.status,
            arbiter_status: arbiterTurn.result.status,
            critic_tools: criticTurn.tools.map((t) => t.name),
            arbiter_tools: arbiterTurn.tools.map((t) => t.name),
            audit_events: audit.length,
            audit_warnings: auditWarnings.length,
            organizer_audit_configured: this.organizerAuditConfigured,
          },
        },
      };
    } finally {
      this.store.delete(jobId);
    }
  }
}
