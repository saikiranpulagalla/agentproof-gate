import { errorReceipt } from "./contracts.js";
import { AgentProofCore } from "./core-engine.js";
import { createCriticProvider } from "./critic.js";
import { IdempotencyCache } from "./idempotency.js";
import { Metrics } from "./metrics.js";
import { Semaphore } from "./semaphore.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { nowMs, sha256 } from "./util.js";
import { SharedOSAgentProofRuntime } from "./sharedos/runtime.js";

export class IdempotencyConflictError extends Error {
  constructor() {
    super("request_id was already used with a different payload");
    this.code = "IDEMPOTENCY_CONFLICT";
  }
}

function timedRace(workPromise, controller, timeoutMs, label, parentSignal) {
  let timer;
  let parentAbort;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "TIMEOUT";
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    if (parentSignal) {
      parentAbort = () => {
        const error = parentSignal.reason instanceof Error ? parentSignal.reason : new Error(`${label} aborted`);
        if (!error.code) error.code = "ABORTED";
        controller.abort(error);
        reject(error);
      };
      if (parentSignal.aborted) parentAbort();
      else parentSignal.addEventListener("abort", parentAbort, { once: true });
    }
  });
  return Promise.race([workPromise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
    if (parentSignal && parentAbort) parentSignal.removeEventListener("abort", parentAbort);
  });
}

export class AgentProofService {
  constructor({ config, core, runtime, semaphore, cache, metrics, rateLimiter }) {
    this.config = config;
    this.core = core;
    this.runtime = runtime;
    this.semaphore = semaphore;
    this.cache = cache;
    this.metrics = metrics;
    this.rateLimiter = rateLimiter;
    this.inflightByCaller = new Map();
  }

  static async create(config, overrides = {}) {
    const criticProvider = createCriticProvider(config, overrides);
    if (config.requireSharedOS && criticProvider.name === "deterministic-only") {
      const error = new Error("Arena mode requires an independent LLM critic; deterministic-only mode is local-test fallback only");
      error.code = "LLM_CRITIC_REQUIRED";
      throw error;
    }
    const core = new AgentProofCore({ criticProvider });
    let runtime = overrides.runtime;
    if (!runtime) {
      try {
        runtime = await SharedOSAgentProofRuntime.create({ core, config, enableEscalation: true });
      } catch (error) {
        if (config.requireSharedOS) throw error;
        runtime = {
          mode: "core-fallback",
          verifyPrepared: (prepared, options) => core.verifyPrepared(prepared, options),
        };
      }
    }
    return new AgentProofService({
      config,
      core,
      runtime,
      semaphore: overrides.semaphore ?? new Semaphore(config.maxConcurrency),
      cache: overrides.cache ?? new IdempotencyCache({ ttlMs: config.idempotencyTtlMs, maxEntries: config.idempotencyMaxEntries }),
      metrics: overrides.metrics ?? new Metrics(),
      rateLimiter: overrides.rateLimiter ?? new SlidingWindowRateLimiter({ limit: config.maxCallsPerCallerPerMinute ?? 24, windowMs: 60_000 }),
    });
  }

  #callerInflight(callerAgentId) {
    return this.inflightByCaller.get(callerAgentId) ?? 0;
  }

  #incrementCaller(callerAgentId) {
    this.inflightByCaller.set(callerAgentId, this.#callerInflight(callerAgentId) + 1);
  }

  #decrementCaller(callerAgentId) {
    const next = this.#callerInflight(callerAgentId) - 1;
    if (next <= 0) this.inflightByCaller.delete(callerAgentId);
    else this.inflightByCaller.set(callerAgentId, next);
  }

  async verify(rawInput, parentSignal, requestContext = {}) {
    const requestStarted = nowMs();
    this.metrics.received();
    let prepared;
    try {
      prepared = await this.core.prepare(rawInput);
    } catch (error) {
      const receipt = errorReceipt(error, rawInput?.request_id);
      this.metrics.record(receipt, nowMs() - requestStarted);
      return receipt;
    }

    const callerAgentId = typeof requestContext.callerAgentId === "string" && requestContext.callerAgentId.trim()
      ? requestContext.callerAgentId.trim().slice(0, 200)
      : "anonymous";
    const trustedAuthorityGap = requestContext.trustedAuthorityGap?.verified === true
      ? requestContext.trustedAuthorityGap
      : null;
    const authorityRevision = trustedAuthorityGap
      ? (trustedAuthorityGap.revision || sha256({ reason: trustedAuthorityGap.reason }).slice(0, 20))
      : "none";
    const key = `${callerAgentId}:${prepared.requestId}:authority:${authorityRevision}`;

    const existing = this.cache.get(key);
    if (existing) {
      if (existing.fingerprint !== prepared.fingerprint) {
        this.metrics.idempotencyConflicts += 1;
        const receipt = errorReceipt(new IdempotencyConflictError(), prepared.requestId);
        this.metrics.record(receipt, nowMs() - requestStarted);
        return receipt;
      }
      this.metrics.idempotentHits += 1;
      return existing.promise;
    }

    const maxInflightPerCaller = this.config.maxInflightPerCaller ?? 2;
    if (this.#callerInflight(callerAgentId) >= maxInflightPerCaller) {
      const error = new Error("caller already has the maximum number of verification requests in flight");
      error.code = "CALLER_BUSY";
      const receipt = errorReceipt(error, prepared.requestId);
      receipt.error.details = { retry_after_ms: 2_000, max_inflight_per_caller: maxInflightPerCaller };
      this.metrics.overloaded += 1;
      this.metrics.record(receipt, nowMs() - requestStarted);
      return receipt;
    }

    if (this.semaphore.active >= this.semaphore.limit && this.semaphore.queued >= (this.config.maxQueue ?? this.semaphore.limit)) {
      const error = new Error("verification capacity is temporarily full; retry shortly");
      error.code = "OVERLOADED";
      const receipt = errorReceipt(error, prepared.requestId);
      receipt.error.details = { retry_after_ms: 5_000 };
      this.metrics.overloaded += 1;
      this.metrics.record(receipt, nowMs() - requestStarted);
      return receipt;
    }

    const rate = this.rateLimiter.consume(callerAgentId);
    if (!rate.allowed) {
      const error = new Error(`rate limit exceeded; retry after ${rate.retryAfterMs}ms`);
      error.code = "RATE_LIMITED";
      const receipt = errorReceipt(error, prepared.requestId);
      receipt.error.details = { retry_after_ms: rate.retryAfterMs };
      this.metrics.record(receipt, nowMs() - requestStarted);
      return receipt;
    }

    this.#incrementCaller(callerAgentId);
    const controller = new AbortController();
    const workPromise = this.semaphore.run(
      () => this.runtime.verifyPrepared(prepared, {
        signal: controller.signal,
        callerAgentId,
        ...(trustedAuthorityGap ? { trustedAuthorityGap } : {}),
      }),
      controller.signal,
    );
    const lifecyclePromise = Promise.resolve(workPromise).then(() => undefined, () => undefined).finally(() => this.#decrementCaller(callerAgentId));

    let publicPromise;
    publicPromise = timedRace(workPromise, controller, this.config.requestTimeoutMs, "verification", parentSignal)
      .catch((error) => {
        if (error?.code === "TIMEOUT") this.metrics.timeouts += 1;
        const receipt = errorReceipt(error, prepared.requestId);
        receipt.receipt.duration_ms = Math.round(nowMs() - requestStarted);
        return receipt;
      })
      .then((receipt) => {
        this.metrics.record(receipt, nowMs() - requestStarted);
        // ERROR and NEEDS_AUTHORITY are not permanent replay results. However,
        // never free the key until actual underlying work has terminated.
        if (receipt?.verdict === "ERROR" || receipt?.verdict === "NEEDS_AUTHORITY") {
          lifecyclePromise.finally(() => this.cache.delete(key));
        }
        return receipt;
      });

    this.cache.put(key, prepared.fingerprint, publicPromise, { lifecyclePromise });
    return publicPromise;
  }

  health() {
    const runtimeName = this.runtime.mode ?? this.runtime.constructor?.name ?? "unknown";
    const sharedosActive = runtimeName !== "core-fallback";
    const organizerAuditConfigured = Boolean(this.runtime.organizerAuditConfigured);
    const sharednetRegistered = Boolean(this.sharednetRegistered);
    const criticName = this.core.criticProvider?.name ?? "unknown";
    const arenaReady = (!this.config.requireSharedOS || sharedosActive)
      && (!this.config.requireSharedOS || organizerAuditConfigured)
      && (!this.config.requireSharedOS || sharednetRegistered)
      && criticName !== "deterministic-only";
    return {
      ok: true,
      arena_ready: arenaReady,
      service: "AgentProof Gate",
      service_name: "verify_before_commit",
      runtime: runtimeName,
      sharedos_required: this.config.requireSharedOS,
      sharedos_active: sharedosActive,
      organizer_audit_configured: organizerAuditConfigured,
      sharednet_registered: sharednetRegistered,
      sharednet_node_id: this.sharednetNodeId ?? null,
      critic: criticName,
      concurrency: { active: this.semaphore.active, queued: this.semaphore.queued, limit: this.semaphore.limit },
      max_inflight_per_caller: this.config.maxInflightPerCaller ?? 2,
    };
  }

  metricSnapshot() {
    return this.metrics.snapshot({
      concurrency: { active: this.semaphore.active, queued: this.semaphore.queued, limit: this.semaphore.limit },
      idempotency_entries: this.cache.size,
      callers_with_inflight: this.inflightByCaller.size,
    });
  }
}
