export const LIMITS = Object.freeze({
  bodyBytes: 64 * 1024,
  goalChars: 4_000,
  candidateChars: 12_000,
  maxConstraints: 20,
  constraintChars: 500,
  maxEvidence: 10,
  evidenceChars: 2_000,
  requestIdChars: 128,
});

export const VERDICTS = Object.freeze([
  "SATISFIED",
  "VIOLATED",
  "UNKNOWN",
  "NEEDS_EVIDENCE",
  "NEEDS_AUTHORITY",
  "ERROR",
]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class InputError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "InputError";
    this.code = code;
    this.details = details;
  }
}

function cleanString(value, field, max, { required = false } = {}) {
  if (value == null) {
    if (required) throw new InputError("INVALID_INPUT", `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InputError("INVALID_INPUT", `${field} must be a string`);
  }
  const normalized = value.normalize("NFKC").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (required && normalized.length === 0) {
    throw new InputError("INVALID_INPUT", `${field} must not be empty`);
  }
  if (normalized.length > max) {
    throw new InputError("INPUT_TOO_LARGE", `${field} exceeds ${max} characters`, {
      field,
      max,
      observed: normalized.length,
    });
  }
  return normalized;
}

function parseConstraints(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InputError("INVALID_INPUT", "constraints must be an array");
  if (value.length > LIMITS.maxConstraints) {
    throw new InputError("INPUT_TOO_LARGE", `constraints exceeds ${LIMITS.maxConstraints} items`);
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = cleanString(value[i], `constraints[${i}]`, LIMITS.constraintChars, { required: true });
    const key = item.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function parseEvidence(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InputError("INVALID_INPUT", "evidence must be an array");
  if (value.length > LIMITS.maxEvidence) {
    throw new InputError("INPUT_TOO_LARGE", `evidence exceeds ${LIMITS.maxEvidence} items`);
  }
  const ids = new Set();
  return value.map((item, i) => {
    if (typeof item === "string") {
      const id = `e${i + 1}`;
      if (ids.has(id)) throw new InputError("INVALID_INPUT", `duplicate evidence id: ${id}`);
      ids.add(id);
      return { id, text: cleanString(item, `evidence[${i}]`, LIMITS.evidenceChars, { required: true }), provenance: "caller_supplied" };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new InputError("INVALID_INPUT", `evidence[${i}] must be a string or object`);
    }
    const evidenceKeys = new Set(["id", "text", "provenance"]);
    const unexpected = Object.keys(item).filter((key) => !evidenceKeys.has(key));
    if (unexpected.length) {
      throw new InputError("INVALID_INPUT", `evidence[${i}] has unsupported fields: ${unexpected.join(", ")}`);
    }
    const id = cleanString(item.id ?? `e${i + 1}`, `evidence[${i}].id`, 80, { required: true });
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
      throw new InputError("INVALID_INPUT", `evidence[${i}].id contains unsupported characters`);
    }
    if (ids.has(id)) throw new InputError("INVALID_INPUT", `duplicate evidence id: ${id}`);
    ids.add(id);
    const text = cleanString(item.text, `evidence[${i}].text`, LIMITS.evidenceChars, { required: true });
    if (item.provenance != null) {
      const claimed = cleanString(item.provenance, `evidence[${i}].provenance`, 80, { required: true }).toLowerCase();
      if (claimed !== "caller_supplied") {
        throw new InputError("INVALID_INPUT", `evidence[${i}].provenance cannot claim trusted provenance; only caller_supplied is accepted`);
      }
    }
    return { id, text, provenance: "caller_supplied" };
  });
}

export function normalizeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("INVALID_INPUT", "request body must be a JSON object");
  }

  const allowed = new Set([
    "goal",
    "candidate",
    "constraints",
    "evidence",
    "artifact_type",
    "request_id",
    "authority_requirement",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new InputError("INVALID_INPUT", `unsupported fields: ${unknown.join(", ")}`);
  }

  const goal = cleanString(value.goal, "goal", LIMITS.goalChars, { required: true });
  const candidate = cleanString(value.candidate, "candidate", LIMITS.candidateChars, { required: true });
  const constraints = parseConstraints(value.constraints);
  const evidence = parseEvidence(value.evidence);
  const artifactType = value.artifact_type == null
    ? "unknown"
    : cleanString(value.artifact_type, "artifact_type", 40, { required: true }).toLowerCase();
  const requestId = value.request_id == null
    ? undefined
    : cleanString(value.request_id, "request_id", LIMITS.requestIdChars, { required: true });
  const authorityRequirement = value.authority_requirement == null
    ? undefined
    : cleanString(value.authority_requirement, "authority_requirement", 400, { required: true });

  return Object.freeze({
    goal,
    candidate,
    constraints,
    evidence,
    artifact_type: artifactType,
    request_id: requestId,
    authority_requirement: authorityRequirement,
    contract_source: constraints.length ? "explicit" : "inferred",
  });
}

export function errorReceipt(error, requestId = undefined) {
  const code = error instanceof InputError ? error.code : (typeof error?.code === "string" ? error.code : "INTERNAL_ERROR");
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    verdict: "ERROR",
    confidence: 1,
    contract: { explicit_constraints: 0, evaluated_constraints: 0, source: "unknown" },
    findings: [],
    residual_unknowns: [],
    repair: null,
    degraded: true,
    error: { code, message, ...(error?.details ? { details: error.details } : {}) },
    receipt: {
      checks_run: 0,
      request_id: requestId ?? null,
      trace_id: null,
      duration_ms: 0,
    },
  };
}
