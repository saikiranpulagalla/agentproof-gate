import crypto from "node:crypto";

export const nowMs = () => performance.now();

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function withTimeout(promiseFactory, timeoutMs, label = "operation", parentSignal = undefined) {
  const controller = new AbortController();
  let timer;
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error(`${label} aborted`));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);
    Promise.resolve()
      .then(() => promiseFactory(controller.signal))
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
      });
  });
}

export function randomId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
