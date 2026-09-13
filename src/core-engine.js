import { normalizeInput } from "./contracts.js";
import { deterministicCheck, evaluateNumericConstraint } from "./deterministic.js";
import { arbitrate } from "./arbiter.js";
import { randomId, sha256, nowMs, normalizeText } from "./util.js";
import { buildContractManifest } from "./requirements.js";

function normalizedContains(haystack, needle) {
  const n = normalizeText(needle).toLowerCase();
  return n.length > 0 && normalizeText(haystack).toLowerCase().includes(n);
}

function normalizeValue(text) {
  return normalizeText(text).toLowerCase().replace(/^["'`\s]+|["'`\s.,;:!?]+$/g, "").replace(/\s+/g, " ").trim();
}

function extractRoute(text) {
  const normalized = normalizeText(text);
  const explicitOrigins = [...normalized.matchAll(/\borigin\s*(?:is|=|:)\s*([^,.;\n]{1,80})/gi)].map((match) => normalizeValue(match[1]));
  const explicitDestinations = [...normalized.matchAll(/\bdestination\s*(?:is|=|:)\s*([^,.;\n]{1,80})/gi)].map((match) => normalizeValue(match[1]));
  if (explicitOrigins.length || explicitDestinations.length) {
    const origins = [...new Set(explicitOrigins)];
    const destinations = [...new Set(explicitDestinations)];
    return {
      origin: origins.length === 1 ? origins[0] : null,
      destination: destinations.length === 1 ? destinations[0] : null,
      originAmbiguous: origins.length > 1,
      destinationAmbiguous: destinations.length > 1,
    };
  }

  // Generic from→to syntax is trusted only inside an explicitly travel-scoped
  // segment. Collect every route claim so contradictory corrections cannot
  // silently reduce to the first match.
  const routes = [];
  for (const segment of normalized.split(/[.;\n]+/u)) {
    if (!/\b(?:flight|travel|trip|route|journey|train|bus|drive|ride|origin|destination|depart(?:ure)?|arriv(?:e|al))\b/i.test(segment)) continue;
    const travel = segment.match(/\bfrom\s+(.{1,80}?)\s+to\s+(.{1,80}?)(?=\s+(?:under|below|at|on|by|for|with|without|via|and)\b|[,]|$)/i);
    if (travel) routes.push({ origin: normalizeValue(travel[1]), destination: normalizeValue(travel[2]) });
  }
  const origins = [...new Set(routes.map((route) => route.origin).filter(Boolean))];
  const destinations = [...new Set(routes.map((route) => route.destination).filter(Boolean))];
  return {
    origin: origins.length === 1 ? origins[0] : null,
    destination: destinations.length === 1 ? destinations[0] : null,
    originAmbiguous: origins.length > 1,
    destinationAmbiguous: destinations.length > 1,
  };
}

function extractDateTokens(text) {
  const iso = text.match(/\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/gi) ?? [];
  const month = text.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+[0-3]?\d(?:st|nd|rd|th)?(?:,?\s+20\d{2})?\b/gi) ?? [];
  return [...new Set([...iso, ...month].map(normalizeValue))];
}

function extractAnchoredDates(text, anchor) {
  if (!anchor) return [];
  const normalized = normalizeText(text);
  const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRe = new RegExp(`\\b${escapedAnchor}\\b`, "i");
  const dates = [];
  for (const segment of normalized.split(/[.;\n]+/u)) {
    if (!anchorRe.test(segment)) continue;
    dates.push(...extractDateTokens(segment));
  }
  return [...new Set(dates)];
}

function actionRegex(action) {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliases = {
    book: "(?:book|reserve)", pay: "(?:pay|send\\s+(?:the\\s+)?payment)", choose: "(?:choose|select)",
    select: "(?:select|choose)", submit: "submit", send: "send", create: "(?:create|issue)", issue: "(?:issue|create)",
    transfer: "transfer", buy: "(?:buy|purchase)", purchase: "(?:purchase|buy)", schedule: "schedule",
  }[action] ?? escaped;
  return aliases;
}

function negativeActionRegex(action) {
  return {
    book: "(?:book|reserve|booking|reserving)",
    pay: "(?:pay|paying|send\\s+(?:the\\s+)?payment|sending\\s+(?:the\\s+)?payment)",
    choose: "(?:choose|select|choosing|selecting)",
    select: "(?:select|choose|selecting|choosing)",
    submit: "(?:submit|submitting)", send: "(?:send|sending)",
    create: "(?:create|issue|creating|issuing)", issue: "(?:issue|create|issuing|creating)",
    transfer: "(?:transfer|transferring)", buy: "(?:buy|purchase|buying|purchasing)",
    purchase: "(?:purchase|buy|purchasing|buying)", schedule: "(?:schedule|scheduling)",
  }[action] ?? actionRegex(action);
}

function structuredStatus(canonical, text) {
  const candidate = normalizeText(text);
  if (!candidate) return { status: "UNKNOWN", reason: "No supporting text was available." };

  if (canonical.kind === "numeric" && canonical.numeric_expression) {
    const result = evaluateNumericConstraint(canonical.numeric_expression, candidate);
    return result
      ? { status: result.status, reason: result.reason ?? result.finding?.reason ?? "" }
      : { status: "UNKNOWN", reason: "Structured numeric expression could not be evaluated safely." };
  }

  if (canonical.kind === "route_origin" || canonical.kind === "route_destination") {
    const route = extractRoute(candidate);
    const isOrigin = canonical.kind === "route_origin";
    const observed = isOrigin ? route.origin : route.destination;
    const ambiguous = isOrigin ? route.originAmbiguous : route.destinationAmbiguous;
    if (ambiguous) return { status: "UNKNOWN", reason: `Candidate states conflicting ${isOrigin ? "origin" : "destination"} values.` };
    if (!observed) return { status: "UNKNOWN", reason: `Candidate does not unambiguously state the ${isOrigin ? "origin" : "destination"}.` };
    const expected = normalizeValue(canonical.expected_text ?? "");
    return observed === expected
      ? { status: "SATISFIED", reason: `${canonical.kind === "route_origin" ? "Origin" : "Destination"} matches ${canonical.expected_text}.` }
      : { status: "VIOLATED", reason: `${canonical.kind === "route_origin" ? "Origin" : "Destination"} is ${observed}, expected ${canonical.expected_text}.` };
  }

  if (canonical.kind === "directness") {
    const direct = /\b(?:direct|nonstop|non-stop)\b/i.test(candidate);
    const connecting = /\b(?:indirect|connecting|connection|[1-9]\s*stops?|one\s+stop|two\s+stops?)\b/i.test(candidate);
    if (direct && connecting) return { status: "UNKNOWN", reason: "Candidate contains conflicting direct and connecting travel claims." };
    if (direct) return { status: "SATISFIED", reason: "Candidate explicitly states direct/nonstop." };
    if (connecting) return { status: "VIOLATED", reason: "Candidate explicitly states a connecting/non-direct option." };
    return { status: "UNKNOWN", reason: "Candidate does not unambiguously state directness." };
  }

  if (canonical.kind === "travel_mode") {
    const expected = normalizeValue(canonical.expected_text ?? "");
    const modes = [...new Set((candidate.match(/\b(?:flight|train|bus)\b/gi) ?? []).map(normalizeValue))];
    if (modes.length > 1) return { status: "UNKNOWN", reason: `Candidate contains conflicting travel modes: ${modes.join(", ")}.` };
    if (modes.length === 1 && modes[0] === expected) return { status: "SATISFIED", reason: `Candidate explicitly uses the required travel mode ${canonical.expected_text}.` };
    if (modes.length === 1) return { status: "VIOLATED", reason: `Candidate uses ${modes[0]}, expected ${canonical.expected_text}.` };
    return { status: "UNKNOWN", reason: "Candidate does not unambiguously establish the required travel mode." };
  }

  if (canonical.kind === "exact_output") {
    const expected = normalizeValue(canonical.expected_text ?? "");
    const observed = normalizeValue(candidate);
    return observed === expected
      ? { status: "SATISFIED", reason: "Candidate exactly matches the required output." }
      : { status: "VIOLATED", reason: `Candidate output ${JSON.stringify(observed)} does not exactly match ${JSON.stringify(expected)}.` };
  }

  if (canonical.kind === "date") {
    const expected = normalizeValue(canonical.expected_text ?? "");
    const dates = extractDateTokens(candidate);
    const anchor = normalizeValue(canonical.date_anchor ?? "");
    const relevantDates = anchor ? extractAnchoredDates(candidate, anchor) : dates;
    if (relevantDates.length > 1) return { status: "UNKNOWN", reason: `Candidate associates multiple conflicting dates with ${anchor || "the dated requirement"}.` };
    if (relevantDates.length === 1 && relevantDates[0] === expected) return { status: "SATISFIED", reason: `Candidate unambiguously associates the required date ${canonical.expected_text} with ${anchor || "the dated requirement"}.` };
    if (relevantDates.length === 1 && anchor) return { status: "VIOLATED", reason: `Candidate associates ${relevantDates[0]} with ${anchor}, expected ${canonical.expected_text}.` };
    // Without a semantic anchor, a different date may describe an unrelated
    // property. Fail safe rather than convicting.
    return { status: "UNKNOWN", reason: "Candidate does not unambiguously establish the required date in the required context." };
  }

  if (canonical.kind === "forbidden_action" && canonical.expected_action && canonical.expected_object) {
    const actionName = canonical.expected_action.toLowerCase();
    const action = actionRegex(actionName);
    const negativeAction = negativeActionRegex(actionName);
    const object = canonical.expected_object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const modifiers = "(?:(?:direct|nonstop|non-stop|selected|requested|chosen|specific|final)\\s+){0,3}";
    const positive = new RegExp(`\\b${action}\\b\\s+(?:the\\s+|a\\s+|an\\s+)?${modifiers}${object}\\b`, "i");
    const negativeSource = `\\b(?:do\\s+not|did\\s+not|will\\s+not|would\\s+not|should\\s+not|don't|never|must\\s+not|cannot|can't|avoid|refrain\\s+from|without|not\\s+to)\\b[^.;\\n]{0,50}\\b${negativeAction}\\b[^.;\\n]{0,40}\\b${object}\\b`;
    const negative = new RegExp(negativeSource, "i");
    const hasNegative = negative.test(candidate);
    const withoutNegativeStatements = candidate.replace(new RegExp(negativeSource, "gi"), " ");
    const hasPositive = positive.test(withoutNegativeStatements);
    if (hasPositive && hasNegative) return { status: "UNKNOWN", reason: `Candidate contains conflicting statements about the forbidden ${canonical.expected_action} ${canonical.expected_object} action.` };
    if (hasNegative) return { status: "SATISFIED", reason: `Candidate explicitly avoids the forbidden ${canonical.expected_action} ${canonical.expected_object} action.` };
    if (hasPositive) return { status: "VIOLATED", reason: `Candidate explicitly proposes the forbidden ${canonical.expected_action} ${canonical.expected_object} action.` };
    return { status: "UNKNOWN", reason: "Candidate does not unambiguously establish whether the forbidden action will occur." };
  }

  if (canonical.kind === "action" && canonical.expected_action && canonical.expected_object) {
    const actionName = canonical.expected_action.toLowerCase();
    const action = actionRegex(actionName);
    const negativeAction = negativeActionRegex(actionName);
    const object = canonical.expected_object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const positive = new RegExp(`\\b${action}\\b\\s+(?:the\\s+|a\\s+|an\\s+)?(?:(?:direct|nonstop|non-stop|selected|requested|chosen|specific|final)\\s+){0,3}${object}\\b`, "i");
    const negativeSource = `\\b(?:do\\s+not|did\\s+not|will\\s+not|would\\s+not|should\\s+not|don't|never|must\\s+not|cannot|can't|avoid|refrain\\s+from|without|not\\s+to)\\b[^.;\\n]{0,50}\\b${negativeAction}\\b[^.;\\n]{0,40}\\b${object}\\b`;
    const negative = new RegExp(negativeSource, "i");
    const hasNegative = negative.test(candidate);
    const withoutNegativeStatements = candidate.replace(new RegExp(negativeSource, "gi"), " ");
    const hasPositive = positive.test(withoutNegativeStatements);
    if (hasPositive && hasNegative) return { status: "UNKNOWN", reason: `Candidate contains conflicting statements about the required ${canonical.expected_action} ${canonical.expected_object} action.` };
    if (hasNegative) return { status: "VIOLATED", reason: `Candidate explicitly negates the required ${canonical.expected_action} ${canonical.expected_object} action.` };
    if (hasPositive) return { status: "SATISFIED", reason: `Candidate explicitly performs the required ${canonical.expected_action} ${canonical.expected_object} action.` };

    // Selection tasks are representational rather than side-effecting: returning
    // a concrete object is itself a selection even when the candidate does not
    // literally repeat "choose/select". Mutating actions (book/pay/send/...)
    // still require the action verb.
    if (["choose", "select"].includes(actionName)) {
      const objectMention = new RegExp(`\\b${object}\\b`, "i");
      if (objectMention.test(candidate)) return { status: "SATISFIED", reason: `Candidate returns a concrete ${canonical.expected_object} selection.` };
    }
    return { status: "UNKNOWN", reason: "Candidate does not unambiguously establish the required action and target." };
  }

  return { status: "UNKNOWN", reason: "Requirement is not host-verifiable with a structured status-aware evaluator." };
}

function deterministicStatusForCanonical(canonical, deterministic) {
  if (canonical.source !== "constraint" || canonical.constraint_index === undefined) return null;
  return deterministic.requirements?.find((item) => item.constraint_index === canonical.constraint_index) ?? null;
}

function validatedEvidenceSupport(item, input, canonical) {
  const evidenceById = new Map(input.evidence.map((entry) => [entry.id, entry]));
  const supports = [];
  for (const support of Array.isArray(item?.evidence_support) ? item.evidence_support : []) {
    if (!support || typeof support.id !== "string" || typeof support.quote !== "string") continue;
    const evidence = evidenceById.get(support.id);
    const quote = support.quote.slice(0, 1200);
    if (!evidence || !quote || !normalizedContains(evidence.text, quote)) continue;
    const direction = structuredStatus(canonical, quote);
    supports.push({ id: support.id, quote, status: direction.status, reason: direction.reason });
  }
  return supports;
}

function sanitizeCritic(critic, input, deterministic) {
  const allowedEvidence = new Set(input.evidence.map((item) => item.id));
  const cleanRefs = (refs) => Array.isArray(refs) ? refs.filter((ref) => allowedEvidence.has(ref)) : [];
  const expected = input.contract_requirements ?? [];
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const byId = new Map();
  const duplicateIds = new Set();
  const unexpectedIds = [];
  const supportUnknowns = [];

  for (const item of critic.requirements ?? []) {
    if (!item || typeof item.id !== "string") continue;
    if (!expectedById.has(item.id)) {
      unexpectedIds.push(item.id);
      continue;
    }
    if (byId.has(item.id)) {
      duplicateIds.add(item.id);
      continue;
    }
    byId.set(item.id, item);
  }

  const requirements = expected.map((canonical) => {
    const item = byId.get(canonical.id);
    if (!item || duplicateIds.has(canonical.id)) {
      return {
        ...canonical,
        status: "UNKNOWN",
        reason: duplicateIds.has(canonical.id)
          ? "Independent critic returned this canonical requirement more than once; coverage is ambiguous."
          : "Independent critic did not evaluate this canonical requirement.",
        evidence_refs: [], evidence_support: [], candidate_quote: "", support_valid: false,
      };
    }

    const quote = typeof item.candidate_quote === "string" ? item.candidate_quote.slice(0, 1200) : "";
    const quoteExists = quote.length > 0 && normalizedContains(input.candidate, quote);
    const deterministicMatch = deterministicStatusForCanonical(canonical, deterministic);
    const hostCandidate = canonical.source === "goal" ? structuredStatus(canonical, input.candidate) : { status: "UNKNOWN", reason: "" };
    const evidenceSupport = validatedEvidenceSupport(item, input, canonical);
    const evidenceRefs = [...new Set([...cleanRefs(item.evidence_refs), ...evidenceSupport.map((support) => support.id)])];

    let status = ["SATISFIED", "VIOLATED", "UNKNOWN"].includes(item.status) ? item.status : "UNKNOWN";
    let supportValid = status === "UNKNOWN";
    let supportReason = "";

    // Explicit constraints already proven by deterministic logic are locked to
    // that proof. A weaker semantic critic cannot reverse them.
    if (deterministicMatch?.status === "SATISFIED" || deterministicMatch?.status === "VIOLATED") {
      if (status !== "UNKNOWN" && status !== deterministicMatch.status) {
        supportUnknowns.push(`${canonical.id} critic status ${status} contradicted deterministic proof ${deterministicMatch.status}; deterministic proof prevailed.`);
      }
      status = deterministicMatch.status;
      supportValid = true;
      supportReason = deterministicMatch.reason;
    } else if (canonical.authority === "structured_partial") {
      // A partially parsed clause may expose useful structure, but its missing
      // qualifier can change the meaning/unit/scope of that structure. It may
      // inform the receipt but cannot independently green or convict.
      if (status !== "UNKNOWN") supportUnknowns.push(`${canonical.id} came from a partially parsed goal clause and cannot independently certify ${status}; downgraded to UNKNOWN.`);
      status = "UNKNOWN";
      supportValid = false;
    } else if (canonical.authority === "advisory" || canonical.kind === "semantic") {
      // Free-form semantics are useful context for the critic but are not a
      // host-verifiable proof certificate. Never let topic overlap become truth.
      if (status !== "UNKNOWN") supportUnknowns.push(`${canonical.id} is advisory/free-form and cannot be certified ${status} by structural quote overlap; downgraded to UNKNOWN.`);
      status = "UNKNOWN";
      supportValid = false;
    } else if (canonical.source === "goal") {
      // Structured goal atoms have a host-derived direction. The critic cannot
      // choose the opposite status merely by citing related text.
      if (hostCandidate.status === "SATISFIED" || hostCandidate.status === "VIOLATED") {
        if (status !== "UNKNOWN" && status !== hostCandidate.status) {
          supportUnknowns.push(`${canonical.id} critic status ${status} contradicted host structured proof ${hostCandidate.status}; host proof prevailed.`);
        }
        status = hostCandidate.status;
        supportValid = true;
        supportReason = hostCandidate.reason;
      } else if (status === "SATISFIED" || status === "VIOLATED") {
        status = "UNKNOWN";
        supportValid = false;
        supportReason = hostCandidate.reason;
        supportUnknowns.push(`${canonical.id} was reported ${item.status} but the host could not establish that direction; downgraded to UNKNOWN.`);
      }
    } else if (status === "SATISFIED" || status === "VIOLATED") {
      // Explicit semantic constraints not covered by deterministic evaluators
      // are intentionally conservative.
      status = "UNKNOWN";
      supportValid = false;
      supportUnknowns.push(`${canonical.id} requires semantic interpretation beyond a host-verifiable evaluator; ${item.status} was downgraded to UNKNOWN.`);
    }

    if ((status === "SATISFIED" || status === "VIOLATED") && canonical.verification_class === "external") {
      const sameDirectionEvidence = evidenceSupport.some((support) => support.status === status);
      if (!sameDirectionEvidence) {
        supportUnknowns.push(`${canonical.id} is external and lacks an exact supplied-evidence quote supporting ${status}; downgraded to UNKNOWN.`);
        status = "UNKNOWN";
        supportValid = false;
      }
    }

    return {
      ...canonical,
      status,
      reason: supportReason || (typeof item.reason === "string" ? item.reason : ""),
      evidence_refs: evidenceRefs,
      evidence_support: evidenceSupport,
      candidate_quote: quoteExists ? quote : "",
      support_valid: supportValid,
    };
  });

  const coverageComplete = input.contract_decomposition_complete === true
    && expected.length > 0
    && duplicateIds.size === 0
    && unexpectedIds.length === 0
    && requirements.every((item) => byId.has(item.id));

  const coverageUnknowns = [];
  for (const item of requirements) {
    if (!byId.has(item.id)) coverageUnknowns.push(`Contract coverage missing canonical requirement ${item.id}.`);
    if (duplicateIds.has(item.id)) coverageUnknowns.push(`Contract coverage duplicated canonical requirement ${item.id}.`);
  }
  if (unexpectedIds.length) coverageUnknowns.push(`Critic returned non-canonical requirement ids: ${[...new Set(unexpectedIds)].join(", ")}.`);
  if (input.contract_decomposition_complete !== true) coverageUnknowns.push("Host-owned contract decomposition is incomplete; SATISFIED is not permitted.");

  return {
    ...critic,
    requirements,
    findings: (critic.findings ?? []).map((item) => ({ ...item, evidence_refs: cleanRefs(item.evidence_refs) })),
    unknowns: [...new Set([...(critic.unknowns ?? []), ...coverageUnknowns, ...supportUnknowns])],
    coverage_complete: coverageComplete,
    expected_requirement_ids: expected.map((item) => item.id),
  };
}

export class AgentProofCore {
  constructor({ criticProvider }) {
    if (!criticProvider?.critique) throw new Error("criticProvider with critique() is required");
    this.criticProvider = criticProvider;
  }

  async prepare(rawInput) {
    const normalized = normalizeInput(rawInput);
    const manifest = buildContractManifest(normalized);
    const input = Object.freeze({
      ...normalized,
      contract_requirements: manifest.requirements,
      contract_decomposition_complete: manifest.decomposition_complete,
      contract_decomposition_unknowns: manifest.unknowns,
    });
    const requestId = input.request_id || randomId("req");
    const fingerprint = sha256({ ...input, request_id: undefined });
    return { input, requestId, fingerprint };
  }

  async critique(input, signal) {
    const deterministic = deterministicCheck(input);
    let critic;
    try {
      critic = sanitizeCritic(await this.criticProvider.critique(input, deterministic, signal), input, deterministic);
    } catch (error) {
      critic = sanitizeCritic({
        source: `${this.criticProvider.name ?? "critic"}-failed`, requirements: [], findings: [],
        unknowns: [`Independent critic unavailable: ${error instanceof Error ? error.message : "unknown error"}`],
        overall: deterministic.critical_finding ? "VIOLATED" : "UNKNOWN",
        confidence: deterministic.critical_finding ? 0.99 : 0.4, degraded: true,
        error_code: error?.code ?? "CRITIC_FAILED",
      }, input, deterministic);
    }
    return { deterministic, critic };
  }

  arbitrate(input, deterministic, critic, trustedContext = {}) {
    return arbitrate(input, deterministic, critic, trustedContext);
  }

  async verifyPrepared({ input, requestId }, { traceId = randomId("trace"), signal, trustedAuthorityGap = null } = {}) {
    const started = nowMs();
    const { deterministic, critic } = await this.critique(input, signal);
    const trustedContext = trustedAuthorityGap?.verified === true ? { authorityGap: trustedAuthorityGap } : {};
    const result = this.arbitrate(input, deterministic, critic, trustedContext);
    return {
      ...result,
      receipt: {
        checks_run: deterministic.checks_run + 1,
        request_id: requestId,
        trace_id: traceId,
        duration_ms: Math.round(nowMs() - started),
        critic: critic.source,
      },
    };
  }

  async verify(rawInput, options = {}) {
    const prepared = await this.prepare(rawInput);
    return this.verifyPrepared(prepared, options);
  }
}
