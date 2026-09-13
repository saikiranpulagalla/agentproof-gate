import { clamp } from "./util.js";

const material = (f) => ["critical", "high"].includes(f.severity) && f.type !== "untrusted_instruction_detected";

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.type}|${f.rule}|${f.observed}|${f.reason}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f, id: `F${out.length + 1}` });
  }
  return out;
}

function semanticConstraintForIndex(input, semantic, index) {
  const canonical = input.contract_requirements?.find((item) => item.source === "constraint" && item.constraint_index === index);
  return canonical ? semantic.find((item) => item.id === canonical.id) : undefined;
}

export function arbitrate(input, deterministic, critic, trustedContext = {}) {
  const findings = dedupeFindings([...(deterministic.findings ?? []), ...(critic.findings ?? [])]);
  const deterministicCritical = findings.filter((f) => f.deterministic && material(f));
  const semanticMaterialFindings = findings.filter((f) => !f.deterministic && material(f));
  const explicit = deterministic.requirements ?? [];
  const semantic = critic.requirements ?? [];
  const semanticViolations = semantic.filter((r) => r.status === "VIOLATED" && r.support_valid !== false);
  const semanticUnknown = semantic.filter((r) => r.status === "UNKNOWN");
  const unsupportedCriticViolation = critic.overall === "VIOLATED" && semanticViolations.length === 0;
  const materialDeterministicUnknowns = deterministic.material_unknowns ?? [];

  const unresolvedExplicit = explicit.filter((r) => {
    if (r.status !== "UNKNOWN") return false;
    const semanticMatch = semanticConstraintForIndex(input, semantic, r.constraint_index);
    return !semanticMatch || semanticMatch.status === "UNKNOWN";
  });

  const canonicalCount = input.contract_requirements?.length ?? 0;
  const coverageComplete = input.contract_decomposition_complete === true
    && critic.coverage_complete === true
    && semantic.length === canonicalCount
    && canonicalCount > 0;
  const allSemanticSatisfied = coverageComplete && semantic.every((r) => r.status === "SATISFIED" && r.support_valid !== false);
  const materialSemanticWarning = semanticMaterialFindings.length > 0 && semanticViolations.length === 0;
  const criticHasUnknowns = (critic.unknowns ?? []).length > 0;
  const greenBlocked = materialDeterministicUnknowns.length > 0
    || unresolvedExplicit.length > 0
    || semanticUnknown.length > 0
    || criticHasUnknowns
    || materialSemanticWarning
    || unsupportedCriticViolation;

  let verdict;
  let confidence;

  // Deterministic proof or a support-certified canonical semantic violation may convict.
  if (deterministicCritical.length > 0 || semanticViolations.length > 0) {
    verdict = "VIOLATED";
    confidence = deterministicCritical.length > 0 ? 0.99 : Math.max(0.75, critic.confidence ?? 0.75);
  } else if (trustedContext.authorityGap?.verified === true && critic.overall === "NEEDS_AUTHORITY") {
    verdict = "NEEDS_AUTHORITY";
    confidence = Math.max(0.8, critic.confidence ?? 0);
  } else if (critic.overall === "NEEDS_EVIDENCE") {
    verdict = "NEEDS_EVIDENCE";
    confidence = Math.max(0.75, critic.confidence ?? 0.75);
  } else if (allSemanticSatisfied && critic.overall === "SATISFIED" && (critic.confidence ?? 0) >= 0.85 && !greenBlocked) {
    // Hard green invariant: complete host-owned atomic coverage, support for every
    // requirement, no material unknowns, and no high/critical semantic warning.
    verdict = "SATISFIED";
    confidence = Math.max(0.85, critic.confidence ?? 0.85);
  } else {
    const externalUnresolved = semantic.some((r) => r.verification_class === "external" && r.status !== "SATISFIED");
    const mentionsEvidence = externalUnresolved || [...(critic.unknowns ?? []), ...materialDeterministicUnknowns]
      .some((x) => /evidence|source|external|unavailable|current|today|latest|world|live|real[- ]?time/i.test(String(x)));
    verdict = mentionsEvidence && input.evidence.length === 0 ? "NEEDS_EVIDENCE" : "UNKNOWN";
    confidence = Math.max(0.55, Math.min(0.9, critic.confidence ?? 0.55));
  }

  const unresolvedHandoff = unresolvedExplicit.map((r) => `Constraint C${(r.constraint_index ?? 0) + 1} remains unresolved after semantic verification.`);
  const unknowns = [...new Set([
    ...(input.contract_decomposition_unknowns ?? []),
    ...(!coverageComplete ? ["Canonical atomic contract coverage is incomplete; SATISFIED is not permitted."] : []),
    ...materialDeterministicUnknowns,
    ...unresolvedHandoff,
    ...(critic.unknowns ?? []),
    ...(unsupportedCriticViolation ? ["Independent critic asserted VIOLATED without a support-certified violated canonical requirement; semantic assertion alone cannot convict."] : []),
    ...(materialSemanticWarning ? ["Independent critic reported a high/critical semantic concern that was not mapped to a support-certified violated canonical requirement; SATISFIED is blocked."] : []),
    ...(critic.overall === "NEEDS_AUTHORITY" && trustedContext.authorityGap?.verified !== true
      ? ["Independent critic requested additional authority, but no trusted SharedOS denial/authority gap was supplied by the host; escalation was not permitted."]
      : []),
  ])];

  const evaluatedExplicit = explicit.filter((r) => {
    if (r.status !== "UNKNOWN") return true;
    const semanticMatch = semanticConstraintForIndex(input, semantic, r.constraint_index);
    return Boolean(semanticMatch && semanticMatch.status !== "UNKNOWN");
  }).length;

  return {
    verdict,
    confidence: clamp(confidence),
    contract: {
      explicit_constraints: input.constraints.length,
      evaluated_constraints: evaluatedExplicit,
      source: input.contract_source,
      canonical_requirements: canonicalCount,
      coverage_complete: coverageComplete,
      decomposition_complete: input.contract_decomposition_complete === true,
    },
    requirements: [...explicit, ...semantic],
    findings,
    residual_unknowns: unknowns,
    repair: null,
    degraded: Boolean(critic.degraded),
    verification_scope: {
      caller_supplied_evidence_only: true,
      external_world_verified: false,
    },
  };
}
