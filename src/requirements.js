import { normalizeText } from "./util.js";

const EXTERNAL_HINT_RE = /\b(?:today|tomorrow|yesterday|currently|current|latest|live|real[- ]?time|cheapest|lowest\s+price|available|weather|rain|snow|stock|trades?|market|flight\s+(?:status|schedule|departs?|arrives?)|still\s+exists?|resigned|released?|vulnerab(?:le|ility))\b/i;
const MONTH_DATE_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+[0-3]?\d(?:st|nd|rd|th)?(?:,?\s+20\d{2})?\b/i;
const ISO_DATE_RE = /\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/i;
const MONEY_LIMIT_RE = /\b(?:under|below|less\s+than|at\s+most|no\s+more\s+than|maximum|max|budget(?:\s+of)?|not\s+over|must\s+not\s+exceed)\s*[$€£₹]?\s*-?\d[\d,.]*/i;
const NEGATION_RE = /\b(?:do\s+not|did\s+not|will\s+not|would\s+not|should\s+not|must\s+not|don't|never|without|avoid|refrain\s+from|cannot|can't|not\s+to)\b/i;
const TRAVEL_CONTEXT_RE = /\b(?:flight|travel|trip|route|journey|train|bus|drive|ride|origin|destination|depart(?:ure)?|arriv(?:e|al))\b/i;

const STOP = new Set([
  "about", "after", "against", "before", "candidate", "correctly", "exactly", "from", "goal", "into",
  "must", "only", "result", "should", "that", "the", "their", "this", "under", "with", "without",
]);

const SUPPORT_SYNONYMS = Object.freeze({
  direct: ["direct", "nonstop", "non-stop"],
  book: ["book", "booking", "booked", "reserve", "reserved", "reservation"],
  pay: ["pay", "paid", "payment", "payroll"],
  choose: ["choose", "chosen", "select", "selected"],
  select: ["choose", "chosen", "select", "selected"],
  submit: ["submit", "submitted", "submission"],
  send: ["send", "sent"],
  create: ["create", "created", "issue", "issued"],
  issue: ["issue", "issued", "create", "created"],
});

const SEMANTIC_SCAFFOLD = new Set([
  "a", "an", "and", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to",
  "must", "please", "required", "requested", "selected", "should", "that", "this", "travel",
  "exactly", "word", "text", "phrase", "return", "output", "respond", "answer", "with",
  "keep", "stay", "final", "do",
]);

function canonicalSemanticToken(token) {
  const lower = token.toLowerCase();
  if (/^(?:booking|booked|reserve|reserved|reservation)$/u.test(lower)) return "book";
  if (/^(?:paid|payment|payroll)$/u.test(lower)) return "pay";
  if (/^(?:chosen|choose|select|selected)$/u.test(lower)) return "select";
  if (/^(?:submitted|submission)$/u.test(lower)) return "submit";
  if (/^(?:sent)$/u.test(lower)) return "send";
  if (/^(?:created|issue|issued)$/u.test(lower)) return "create";
  if (/^(?:nonstop|non-stop)$/u.test(lower)) return "direct";
  if (/^(?:budget|price|cost|total|amount|fee|charge)$/u.test(lower)) return "money";
  return lower;
}

function semanticTokens(text) {
  const normalized = normalizeText(text).toLowerCase();
  const words = normalized.match(/[a-z][a-z0-9-]{1,}/g) ?? [];
  const numbers = normalized.match(/-?\d[\d,.]*/g) ?? [];
  return [...new Set([
    ...words
      .map(canonicalSemanticToken)
      .filter((word) => !STOP.has(word) && !SEMANTIC_SCAFFOLD.has(word)),
    ...numbers.map((value) => `#${value.replace(/[,.]+$/g, "")}`),
  ])];
}

function supportTerms(text) {
  const words = normalizeText(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return [...new Set(words.filter((word) => !STOP.has(word)))].slice(0, 12);
}

function verificationClass(text) {
  return EXTERNAL_HINT_RE.test(text) ? "external" : "local";
}

function makeRequirement({
  source,
  requirement,
  kind = "semantic",
  constraintIndex,
  support = [],
  metadata = {},
  authority = "structured",
}) {
  return {
    source,
    requirement: normalizeText(requirement),
    kind,
    authority,
    verification_class: verificationClass(requirement),
    support_terms: [...new Set([...support, ...supportTerms(requirement)])].slice(0, 16),
    ...(constraintIndex === undefined ? {} : { constraint_index: constraintIndex }),
    ...metadata,
  };
}

function splitGoalClauses(goal) {
  const normalized = normalizeText(goal);
  // Split only on strong separators. Do not split on "and" because it can bind
  // noun phrases ("Hyderabad and Delhi") or scopes and is unsafe heuristically.
  return normalized
    .split(/\s*(?:;|\n|\bthen\b)\s*/i)
    .map((part) => part.trim().replace(/^[,.;:\-]+|[,.;:\-]+$/g, ""))
    .filter(Boolean);
}

function routeAtoms(clause) {
  if (!TRAVEL_CONTEXT_RE.test(clause)) return [];
  const match = clause.match(/\bfrom\s+(.{1,80}?)\s+to\s+(.{1,80}?)(?=\s+(?:under|below|at|on|by|for|with|without|via|and)\b|[,.]|$)/i);
  if (!match) return [];
  const origin = normalizeText(match[1]);
  const destination = normalizeText(match[2]);
  if (!origin || !destination) return [];
  return [
    makeRequirement({
      source: "goal",
      requirement: `Origin must be ${origin}.`,
      kind: "route_origin",
      support: [origin.toLowerCase()],
      metadata: { expected_text: origin },
    }),
    makeRequirement({
      source: "goal",
      requirement: `Destination must be ${destination}.`,
      kind: "route_destination",
      support: [destination.toLowerCase()],
      metadata: { expected_text: destination },
    }),
  ];
}

function exactOutputAtom(clause) {
  const match = clause.match(/\b(?:return|output|respond\s+with|answer\s+with)\s+(?:exactly\s+)?(?:the\s+(?:word|text|phrase)\s+)?["'`]?([^"'`.,;]{1,80})["'`]?(?:[.!?]|$)/i);
  if (!match) return null;
  const expected = normalizeText(match[1]).replace(/^the\s+(?:word|text|phrase)\s+/i, "").trim();
  if (!expected || /\b(?:a|an|the)\s+(?:response|answer|result)\b/i.test(expected)) return null;
  return makeRequirement({
    source: "goal",
    requirement: `Candidate output must exactly equal ${JSON.stringify(expected)}.`,
    kind: "exact_output",
    support: supportTerms(expected),
    metadata: { expected_text: expected },
  });
}

function dateAnchor(clause) {
  return clause.match(/\b(deadline|due|meeting|flight|departure|arrival|delivery|launch|event|session|booking|submission)\b/i)?.[1]?.toLowerCase() ?? null;
}

function travelModeAtom(clause) {
  const mode = clause.match(/\b(flight|train|bus)\b/i)?.[1]?.toLowerCase();
  if (!mode || !TRAVEL_CONTEXT_RE.test(clause)) return null;
  return makeRequirement({
    source: "goal",
    requirement: `Travel mode must be ${mode}.`,
    kind: "travel_mode",
    support: [mode],
    metadata: { expected_text: mode },
  });
}

function safeActionAtom(clause) {
  // If a clause contains negation, do not attempt to infer a positive action.
  // The residual-clause guard below will keep the clause advisory/incomplete.
  if (NEGATION_RE.test(clause)) return null;
  const match = clause.match(/\b(book|pay|choose|select|submit|send|create|issue|transfer|buy|purchase|schedule)\b\s+(?:the\s+|a\s+|an\s+)?(?:(?:direct|nonstop|non-stop|selected|requested|chosen|specific|final)\s+){0,3}(flight|invoice|payment|salary|form|application|report|document|meeting|option|plan|result|answer|code)\b/i);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const object = match[2].toLowerCase();
  return makeRequirement({
    source: "goal",
    requirement: `Candidate must ${action} the requested ${object}.`,
    kind: "action",
    support: [...(SUPPORT_SYNONYMS[action] ?? [action]), object],
    metadata: { expected_action: action, expected_object: object },
  });
}

function forbiddenActionAtom(clause) {
  const base = "book|pay|choose|select|submit|send|create|issue|transfer|buy|purchase|schedule";
  const object = "flight|invoice|payment|salary|form|application|report|document|meeting|option|plan|result|answer|code";
  const modifiers = "(?:(?:direct|nonstop|non-stop|selected|requested|chosen|specific|final)\\s+){0,3}";
  let match = clause.match(new RegExp(`\\b(?:do\\s+not|did\\s+not|will\\s+not|would\\s+not|don't|never|must\\s+not|should\\s+not|cannot|can't|not\\s+to)\\s+(?:ever\\s+)?(${base})\\s+(?:the\\s+|a\\s+|an\\s+)?${modifiers}(${object})\\b`, "i"));
  if (!match) {
    const gerunds = { booking: "book", paying: "pay", choosing: "choose", selecting: "select", submitting: "submit", sending: "send", creating: "create", issuing: "issue", transferring: "transfer", buying: "buy", purchasing: "purchase", scheduling: "schedule" };
    match = clause.match(new RegExp(`\\b(?:avoid|without|refrain\\s+from)\\s+(booking|paying|choosing|selecting|submitting|sending|creating|issuing|transferring|buying|purchasing|scheduling)\\s+(?:the\\s+|a\\s+|an\\s+)?${modifiers}(${object})\\b`, "i"));
    if (match) match = [match[0], gerunds[match[1].toLowerCase()], match[2]];
  }
  if (!match) return null;
  const action = match[1].toLowerCase();
  const target = match[2].toLowerCase();
  return makeRequirement({
    source: "goal",
    requirement: `Candidate must not ${action} the requested ${target}.`,
    kind: "forbidden_action",
    support: ["not", "avoid", "without", "refrain", ...(SUPPORT_SYNONYMS[action] ?? [action]), target],
    metadata: { expected_action: action, expected_object: target },
  });
}

function residualSemanticTokens(clause, structuredRequirements, extraCoverage = []) {
  const clauseTokens = semanticTokens(clause);
  const covered = new Set();
  for (const item of structuredRequirements) {
    for (const token of item.support_terms ?? []) covered.add(canonicalSemanticToken(String(token)));
    for (const token of semanticTokens(item.expected_text ?? "")) covered.add(token);
    for (const token of semanticTokens(item.numeric_expression ?? "")) covered.add(token);
    if (item.expected_action) covered.add(canonicalSemanticToken(item.expected_action));
    if (item.expected_object) covered.add(canonicalSemanticToken(item.expected_object));
  }
  for (const token of extraCoverage) covered.add(canonicalSemanticToken(String(token)));
  return clauseTokens.filter((token) => !covered.has(token));
}

function goalAtoms(goal, extraCoverage = []) {
  const atoms = [];
  let advisoryCount = 0;

  for (const clause of splitGoalClauses(goal)) {
    const special = [];
    const clauseVerification = verificationClass(clause);
    const negated = NEGATION_RE.test(clause);
    const forbiddenAction = forbiddenActionAtom(clause);

    if (forbiddenAction) special.push(forbiddenAction);
    if (!negated) {
      const exact = exactOutputAtom(clause);
      if (exact) special.push(exact);
      special.push(...routeAtoms(clause));
      const mode = travelModeAtom(clause);
      if (mode) special.push(mode);
    }

    if (!negated && /\b(?:direct|nonstop|non-stop)\b/i.test(clause)) {
      special.push(makeRequirement({
        source: "goal",
        requirement: "Selected travel option must be direct/nonstop.",
        kind: "directness",
        support: SUPPORT_SYNONYMS.direct,
      }));
    }

    const date = !negated ? (clause.match(ISO_DATE_RE)?.[0] ?? clause.match(MONTH_DATE_RE)?.[0]) : null;
    if (date) {
      special.push(makeRequirement({
        source: "goal",
        requirement: `Required date is ${date}.`,
        kind: "date",
        support: supportTerms(date),
        metadata: { expected_text: date, date_anchor: dateAnchor(clause) },
      }));
    }

    const money = !forbiddenAction ? clause.match(MONEY_LIMIT_RE)?.[0] : null;
    if (money) {
      special.push(makeRequirement({
        source: "goal",
        requirement: `Budget requirement: ${money}.`,
        kind: "numeric",
        support: supportTerms(money),
        metadata: { numeric_expression: money },
      }));
    }

    const action = !negated ? safeActionAtom(clause) : null;
    if (action) special.push(action);

    // A structured parse is authoritative only for the semantics it actually
    // covered. Any meaningful residual token keeps the full clause as advisory
    // context and marks decomposition incomplete, preventing partial parses from
    // producing a false green (for example: "... under $300 and refundable").
    const residual = special.length > 0 ? residualSemanticTokens(clause, special, extraCoverage) : semanticTokens(clause).filter((token) => !extraCoverage.includes(token));
    if (special.length === 0 || residual.length > 0) {
      if (residual.length > 0) {
        for (const item of special) item.authority = "structured_partial";
      }
      special.push(makeRequirement({
        source: "goal",
        requirement: clause,
        kind: "semantic",
        authority: "advisory",
        metadata: { residual_terms: residual },
      }));
      advisoryCount += 1;
    }

    // Preserve epistemic context from the original clause even when the
    // structured requirement text itself omits words such as "today".
    for (const item of special) item.verification_class = clauseVerification;

    for (const item of special) {
      const key = `${item.kind}|${item.requirement}`.toLowerCase();
      if (!atoms.some((existing) => `${existing.kind}|${existing.requirement}`.toLowerCase() === key)) atoms.push(item);
    }
  }
  return { atoms, advisoryCount };
}

/**
 * Build a host-owned contract manifest. Only high-confidence structured atoms
 * are authoritative. Unsafe/free-form clauses remain advisory and make the
 * decomposition incomplete, so a model cannot turn a heuristic parse into a
 * false green or false red.
 */
export function buildContractManifest(input) {
  const constraints = input.constraints.map((constraint, index) => makeRequirement({
    source: "constraint",
    requirement: constraint,
    kind: "constraint",
    constraintIndex: index,
    authority: "explicit",
  }));
  const constraintCoverage = [...new Set(input.constraints.flatMap(semanticTokens))];
  const goal = goalAtoms(input.goal, constraintCoverage);
  const raw = [...goal.atoms, ...constraints];
  const maxRequirements = 25;
  const boundedOk = raw.length > 0 && raw.length <= maxRequirements;
  const decompositionComplete = boundedOk && goal.advisoryCount === 0;
  const bounded = raw.slice(0, maxRequirements).map((item, index) => Object.freeze({ id: `M${index + 1}`, ...item }));
  const unknowns = [];
  if (!boundedOk) unknowns.push("Contract decomposition exceeded the bounded requirement surface; SATISFIED is not permitted.");
  if (goal.advisoryCount > 0) unknowns.push("At least one goal clause could not be safely decomposed into authoritative structured requirements; SATISFIED is not permitted.");
  return Object.freeze({
    requirements: Object.freeze(bounded),
    decomposition_complete: decompositionComplete,
    unknowns: Object.freeze(unknowns),
  });
}

export function buildContractRequirements(input) {
  return buildContractManifest(input).requirements;
}
