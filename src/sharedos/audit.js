import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class CompositeAuditSink {
  constructor(sinks) {
    this.sinks = sinks.filter(Boolean);
  }

  async record(event) {
    const settled = await Promise.allSettled(this.sinks.map((sink) => sink.record(event)));
    const failures = settled
      .map((result, index) => result.status === "rejected" ? { index, error: result.reason } : null)
      .filter(Boolean);
    if (failures.length) throw new AggregateError(failures.map((item) => item.error), `audit delivery failed for ${failures.length} sink(s)`);
  }
}

function timeoutError(label, timeoutMs, code) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = code;
  return error;
}

async function bounded(operation, timeoutMs, label, code) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(label, timeoutMs, code);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TimeoutAuditSink {
  constructor(sink, timeoutMs = 3_000, label = "organizer audit", { maxOutstanding = 1 } = {}) {
    if (!sink?.record) throw new TypeError("TimeoutAuditSink requires sink.record(event)");
    this.sink = sink;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.maxOutstanding = maxOutstanding;
    this.pending = new Set();
  }

  async record(event) {
    if (this.pending.size >= this.maxOutstanding) {
      const error = new Error(`${this.label} still has ${this.pending.size} unresolved write(s); refusing to accumulate more`);
      error.code = "AUDIT_BACKPRESSURE";
      throw error;
    }

    const controller = new AbortController();
    const work = Promise.resolve().then(() => this.sink.record(event, { signal: controller.signal }));
    this.pending.add(work);
    work.finally(() => this.pending.delete(work)).catch(() => {});

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(this.label, this.timeoutMs, "AUDIT_DELIVERY_TIMEOUT");
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class BestEffortAuditSink {
  constructor(sink, onError = () => {}) {
    this.sink = sink;
    this.onError = onError;
  }
  async record(event) {
    try { await this.sink.record(event); }
    catch (error) { this.onError(error, event); }
  }
}

export class MemoryAuditSink {
  constructor(events = []) { this.events = events; }
  async record(event) { this.events.push(event); }
}

export class NdjsonAuditSink {
  constructor(filePath) { this.filePath = filePath; }
  async record(event) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export async function loadOrganizerAuditSink(modulePath, { timeoutMs = 5_000 } = {}) {
  if (!modulePath) return null;
  const resolved = modulePath.startsWith(".") || path.isAbsolute(modulePath)
    ? pathToFileURL(path.resolve(modulePath)).href
    : modulePath;
  const mod = await bounded((signal) => import(resolved).then(async (loaded) => {
    if (loaded.auditSink) return loaded.auditSink;
    if (typeof loaded.createAuditSink === "function") return loaded.createAuditSink({ signal });
    return null;
  }), timeoutMs, "organizer audit initialization", "AUDIT_INIT_TIMEOUT");
  if (!mod?.record) throw new Error("Organizer audit module must export auditSink.record(event) or createAuditSink()");
  return mod;
}
