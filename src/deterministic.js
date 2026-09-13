import { normalizeText } from "./util.js";

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|system)\s+instructions?/i,
  /return\s+(only\s+)?(pass|satisfied|approved)/i,
  /you\s+are\s+now\s+(the\s+)?system/i,
  /reveal\s+(the\s+)?system\s+prompt/i,
  /grant\s+(me\s+)?(access|permission|authority)/i,
];

const NUMBER_TOKEN_SOURCE = String.raw`-?\d[\d,]*(?:\.\d+)?`;
const CURRENCY_AMOUNT_RE = new RegExp(String.raw`(?:[$€£₹]\s*${NUMBER_TOKEN_SOURCE}|${NUMBER_TOKEN_SOURCE}\s*(?:usd|eur|gbp|inr|dollars?|euros?|rupees?))`, "gi");
const MONEY_LABEL_RE = /\b(?:grand\s+total|final\s+(?:price|cost|total|amount)|total(?:\s+(?:price|cost|amount|fee|charge))?|price|cost|amount|balance|salary|payment|fee|charge)\b/i;
const ISO_DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
const MONTH_DATE_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
const MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
});

function finding({ type, severity = "medium", rule, observed, evidenceRefs = [], reason, deterministic = true }) {
  return {
    type,
    severity,
    rule,
    observed,
    evidence_refs: evidenceRefs,
    reason,
    deterministic,
  };
}

function currencyCode(text) {
  const found = new Set();
  if (/\$|\busd\b|\bdollars?\b/i.test(text)) found.add("USD");
  if (/€|\beur\b|\beuros?\b/i.test(text)) found.add("EUR");
  if (/£|\bgbp\b/i.test(text)) found.add("GBP");
  if (/₹|\binr\b|\brupees?\b/i.test(text)) found.add("INR");
  return found.size === 1 ? [...found][0] : found.size === 0 ? null : "AMBIGUOUS";
}


const UNIT_PATTERNS = Object.freeze([
  ["millisecond", /\b(?:milliseconds?|msecs?|ms)\b/i],
  ["second", /\b(?:seconds?|secs?)\b/i],
  ["minute", /\b(?:minutes?|mins?)\b/i],
  ["hour", /\b(?:hours?|hrs?)\b/i],
  ["day", /\b(?:days?)\b/i],
  ["week", /\b(?:weeks?|wks?)\b/i],
  ["km", /\b(?:km|kilometers?|kilometres?)\b/i],
  ["meter", /\b(?:m|meters?|metres?)\b/i],
  ["GB", /\b(?:gb|gigabytes?)\b/i],
  ["MB", /\b(?:mb|megabytes?)\b/i],
  ["KB", /\b(?:kb|kilobytes?)\b/i],
  ["byte", /\b(?:bytes?)\b/i],
  ["percent", /%|\bpercent(?:age)?\b/i],
]);

function unitCode(text) {
  const found = UNIT_PATTERNS.filter(([, re]) => re.test(text)).map(([code]) => code);
  return found.length === 1 ? found[0] : found.length === 0 ? null : "AMBIGUOUS";
}

function unrecognizedUnitSuffix(text) {
  const suffixes = [];
  const re = new RegExp(`(?:${NUMBER_TOKEN_SOURCE})\\s*([A-Za-z][A-Za-z0-9_-]{0,20}|%)(?=\\s|$|[.,;:!?])`, "gi");
  for (const match of text.matchAll(re)) {
    const raw = match[1].toLowerCase();
    if (/^(?:usd|eur|gbp|inr|dollars?|euros?|rupees?)$/i.test(raw)) continue;
    if (unitCode(raw)) continue;
    suffixes.push(raw);
  }
  return [...new Set(suffixes)];
}

function measurementUnit(text) {
  const known = unitCode(text);
  if (known) return known;
  const unknown = unrecognizedUnitSuffix(text);
  if (unknown.length === 1) return `UNRECOGNIZED:${unknown[0]}`;
  if (unknown.length > 1) return "AMBIGUOUS";
  return null;
}

function extractUnitQuantities(text) {
  const units = String.raw`milliseconds?|msecs?|ms|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|km|kilometers?|kilometres?|m|meters?|metres?|gb|gigabytes?|mb|megabytes?|kb|kilobytes?|bytes?|percent(?:age)?|%`;
  const re = new RegExp(`(${NUMBER_TOKEN_SOURCE})\\s*(${units})(?=\\s|$|[.,;:!?])`, "gi");
  const out = [];
  for (const match of text.matchAll(re)) {
    const value = parseNumberToken(match[1]);
    const unit = unitCode(match[2]);
    if (Number.isFinite(value) && unit && unit !== "AMBIGUOUS") out.push({ value, raw: match[0], index: match.index ?? -1, currency: null, unit });
  }
  return out;
}

function parseNumberToken(raw) {
  let token = raw.trim().replace(/^[^0-9-]+|[^0-9.,]+$/g, "");
  if (!token) return null;
  const sign = token.startsWith("-") ? -1 : 1;
  if (sign < 0) token = token.slice(1);
  if (!/^\d[\d,.]*$/.test(token)) return null;

  const commas = (token.match(/,/g) ?? []).length;
  const dots = (token.match(/\./g) ?? []).length;
  if (dots > 1) return null;
  if (dots === 1) {
    if (commas && !/^\d{1,3}(?:,\d{2})*(?:,\d{3})?\.\d+$/.test(token) && !/^\d{1,3}(?:,\d{3})+\.\d+$/.test(token)) return null;
    const value = Number(token.replace(/,/g, ""));
    return Number.isFinite(value) ? sign * value : null;
  }
  if (commas === 0) {
    const value = Number(token);
    return Number.isFinite(value) ? sign * value : null;
  }
  if (/^\d{1,3}(?:,\d{2})+,\d{3}$/.test(token) || /^\d{1,3}(?:,\d{3})+$/.test(token)) {
    return sign * Number(token.replace(/,/g, ""));
  }
  if (/^\d+,\d{2}$/.test(token)) {
    return sign * Number(token.replace(",", "."));
  }
  return null;
}

function amountFromRaw(raw) {
  const numeric = raw.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!numeric) return null;
  const value = parseNumberToken(numeric[0]);
  if (!Number.isFinite(value)) return null;
  return { value, raw, currency: currencyCode(raw) };
}

function numbers(text) {
  const out = [];
  const re = new RegExp(NUMBER_TOKEN_SOURCE, "g");
  for (const match of text.matchAll(re)) {
    const value = parseNumberToken(match[0]);
    if (Number.isFinite(value)) out.push({ value, raw: match[0], index: match.index ?? -1, currency: null });
  }
  return out;
}

function extractMonetaryAmounts(text) {
  const out = [];
  for (const match of text.matchAll(CURRENCY_AMOUNT_RE)) {
    const parsed = amountFromRaw(match[0]);
    if (parsed) {
      const index = match.index ?? -1;
      const prefix = index >= 0 ? text.slice(Math.max(0, index - 60), index + match[0].length) : match[0];
      out.push({ ...parsed, index, label: prefix });
    }
  }
  // Plain numeric values are monetary only when a nearby monetary label names them.
  const labelled = new RegExp(String.raw`\b(?:grand\s+total|final\s+(?:price|cost|total|amount)|total(?:\s+(?:price|cost|amount|fee|charge))?|price|cost|amount|balance|salary|payment|fee|charge)\b(?:\s+(?:is|of))?\s*[=:]?\s*(${NUMBER_TOKEN_SOURCE})`, "gi");
  for (const match of text.matchAll(labelled)) {
    if (currencyCode(match[0])) continue; // already captured above
    const value = parseNumberToken(match[1]);
    if (Number.isFinite(value)) out.push({ value, raw: match[1], index: match.index ?? -1, currency: null, label: match[0] });
  }
  // De-duplicate exact span/value pairs.
  return out.filter((item, index, all) => all.findIndex((other) => other.index === item.index && other.value === item.value && other.currency === item.currency) === index);
}

function parseNumericConstraint(text) {
  const normalized = normalizeText(text).toLowerCase();
  const number = NUMBER_TOKEN_SOURCE;
  const patterns = [
    { op: "<=", re: new RegExp(String.raw`(?:<=|at\s+most|no\s+more\s+than|maximum(?:\s+(?:allowed|total))?(?:\s+is|\s+of)?|not\s+(?:above|over)|must\s+not\s+exceed)\s*[$€£₹]?\s*(${number})`, "i") },
    { op: "<", re: new RegExp(String.raw`(?:<|less\s+than|under|below)\s*[$€£₹]?\s*(${number})`, "i") },
    { op: ">=", re: new RegExp(String.raw`(?:>=|at\s+least|minimum(?:\s+(?:required|allowed))?(?:\s+is|\s+of)?|not\s+(?:below|under)|must\s+be\s+at\s+least)\s*[$€£₹]?\s*(${number})`, "i") },
    { op: ">", re: new RegExp(String.raw`(?:>|more\s+than|above|over)\s*[$€£₹]?\s*(${number})`, "i") },
    { op: "=", re: new RegExp(String.raw`(?:==|exactly|equal\s+to|must\s+be)\s*[$€£₹]?\s*(${number})`, "i") },
  ];
  for (const { op, re } of patterns) {
    const match = normalized.match(re);
    if (match) {
      const value = parseNumberToken(match[1]);
      if (Number.isFinite(value)) return { op, value, currency: currencyCode(text), unit: measurementUnit(text) };
    }
  }
  const symbolic = normalized.match(new RegExp(String.raw`(?:\b(?:price|cost|budget|total|balance|amount|score|count|limit)\b[^\d<>={}]*)?(<=|>=|<|>|=)\s*[$€£₹]?\s*(${number})`, "i"));
  if (symbolic) {
    const value = parseNumberToken(symbolic[2]);
    if (Number.isFinite(value)) return { op: symbolic[1], value, currency: currencyCode(text), unit: measurementUnit(text) };
  }
  return null;
}
function compare(a, op, b) {
  if (op === "<=") return a <= b;
  if (op === "<") return a < b;
  if (op === ">=") return a >= b;
  if (op === ">") return a > b;
  if (op === "=") return Math.abs(a - b) < 1e-9;
  return false;
}

export function evaluateNumericConstraint(constraint, candidate) {
  const parsed = parseNumericConstraint(constraint);
  if (!parsed) return null;
  const monetaryConstraint = /\b(price|cost|budget|total|amount|balance|salary|payment|fee|charge)\b/i.test(constraint) || parsed.currency;
  let candidateNumbers;
  if (monetaryConstraint) {
    candidateNumbers = extractMonetaryAmounts(candidate);
  } else if (parsed.unit) {
    if (parsed.unit === "AMBIGUOUS") return { status: "UNKNOWN", reason: "Constraint unit is ambiguous; no unit conversion was attempted." };
    if (String(parsed.unit).startsWith("UNRECOGNIZED:")) return { status: "UNKNOWN", reason: `Constraint uses an unrecognized measurement unit (${parsed.unit.slice("UNRECOGNIZED:".length)}); raw numeric comparison was refused.` };
    candidateNumbers = extractUnitQuantities(candidate);
    if (candidateNumbers.length === 1 && candidateNumbers[0].unit !== parsed.unit) {
      return { status: "UNKNOWN", reason: `Constraint unit is ${parsed.unit}, but candidate unit is ${candidateNumbers[0].unit}; no unit conversion was performed.` };
    }
  } else {
    candidateNumbers = numbers(candidate);
  }

  if (monetaryConstraint && candidateNumbers.length > 1) {
    // Multiple monetary components are dangerous to collapse. Prefer exactly one
    // explicitly labelled grand/final total; otherwise refuse to guess.
    const totals = candidateNumbers.filter((item) => /\b(?:grand\s+total|final\s+(?:price|cost|total|amount)|total(?:\s+(?:price|cost|amount|fee|charge))?)\b/i.test(item.label ?? item.raw));
    if (totals.length === 1) candidateNumbers = totals;
  }

  if (candidateNumbers.length !== 1) {
    return {
      status: "UNKNOWN",
      reason: candidateNumbers.length === 0
        ? "No unambiguous value tied to the constrained quantity was found in the candidate."
        : "Multiple relevant values were found; refusing to guess which value the constraint refers to.",
    };
  }

  const observed = candidateNumbers[0];
  if (parsed.currency === "AMBIGUOUS" || observed.currency === "AMBIGUOUS") {
    return { status: "UNKNOWN", reason: "Currency is ambiguous; no FX or unit conversion was performed." };
  }
  if (parsed.currency && observed.currency !== parsed.currency) {
    return { status: "UNKNOWN", reason: `Constraint is in ${parsed.currency}, but candidate currency is ${observed.currency ?? "unspecified"}; no FX conversion was performed.` };
  }
  if (parsed.unit && observed.unit !== parsed.unit) {
    return { status: "UNKNOWN", reason: `Constraint unit is ${parsed.unit}, but candidate unit is ${observed.unit ?? "unspecified"}; no unit conversion was performed.` };
  }

  const ok = compare(observed.value, parsed.op, parsed.value);
  return ok
    ? { status: "SATISFIED", reason: `${observed.raw} satisfies ${parsed.op} ${parsed.value}.` }
    : {
        status: "VIOLATED",
        finding: finding({
          type: "constraint_violation",
          severity: "critical",
          rule: constraint,
          observed: observed.raw,
          reason: `${observed.value} does not satisfy ${parsed.op} ${parsed.value}.`,
        }),
      };
}
function extractQuotedTarget(constraint) {
  const quoted = constraint.match(/["'`](.+?)["'`]/);
  if (quoted) return quoted[1].trim();
  return null;
}

function normalizedPhrase(text) {
  return normalizeText(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function phraseBoundaryMatch(candidate, target) {
  const words = normalizedPhrase(target).split(" ").filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return false;
  const pattern = words.join("\\s+");
  return new RegExp(`(?:^|[^A-Za-z0-9_])${pattern}(?=$|[^A-Za-z0-9_])`, "i").test(normalizeText(candidate));
}

export function evaluateTextConstraint(constraint, candidate) {
  const normalized = normalizeText(constraint);
  const lower = normalized.toLowerCase();
  const target = extractQuotedTarget(normalized);
  if (!target) return null;
  const verb = lower.match(/\b(contain|include|mention|use)\b/i)?.[1];
  if (!verb) return null;
  const contains = verb === "mention" || verb === "use"
    ? phraseBoundaryMatch(candidate, target)
    : normalizedPhrase(candidate).includes(normalizedPhrase(target));
  if (/\b(must\s+not|do\s+not|never|cannot|can't)\b/i.test(lower)) {
    return contains
      ? { status: "VIOLATED", finding: finding({ type: "constraint_violation", severity: "high", rule: constraint, observed: target, reason: `Candidate contains forbidden text: ${target}` }) }
      : { status: "SATISFIED", reason: `Forbidden text ${target} was not found.` };
  }
  if (/\b(must|should|required\s+to)\b/i.test(lower)) {
    return contains
      ? { status: "SATISFIED", reason: `Required text ${target} was found.` }
      : { status: "VIOLATED", finding: finding({ type: "constraint_violation", severity: "high", rule: constraint, observed: "missing", reason: `Candidate is missing required text: ${target}` }) };
  }
  return null;
}
function evaluateDirectnessConstraint(constraint, candidate) {
  if (!/\b(?:direct|nonstop|non-stop)\b/i.test(constraint)) return null;
  if (/\b(?:direct|nonstop|non-stop)\b/i.test(candidate)) {
    return { status: "SATISFIED", reason: "Candidate explicitly states a direct/nonstop option." };
  }
  if (/\b(?:indirect|connecting|connection|[1-9]\s*stops?|one\s+stop|two\s+stops?)\b/i.test(candidate)) {
    return {
      status: "VIOLATED",
      finding: finding({
        type: "constraint_violation", severity: "high", rule: constraint, observed: "non-direct option",
        reason: "Candidate explicitly describes a connecting/non-direct option.",
      }),
    };
  }
  return { status: "UNKNOWN", reason: "Candidate does not unambiguously state whether the option is direct/nonstop." };
}

function meaningfulTokens(text) {
  const stop = new Set([
    "about", "action", "already", "completed", "exactly", "exists", "must", "once", "only", "recorded",
    "should", "the", "this", "that", "transaction", "with", "without", "from", "into", "now", "will", "would",
  ]);
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []).filter((token) => !stop.has(token)));
}

const ACTION_FAMILIES = [
  { candidate: /\b(?:pay|payment|payroll|salary|send\s+(?:the\s+)?payment)\b/i, evidence: /\b(?:payment|invoice|salary(?:\s+transaction)?|payroll(?:\s+transaction)?)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:paid|sent|completed|executed|recorded)\b|\b(?:already|previously)\s+(?:paid|sent)\b/i },
  { candidate: /\b(?:book|booking)\b/i, evidence: /\b(?:flight|booking|reservation)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:booked|reserved|completed)\b|\b(?:already|previously)\s+(?:booked|reserved)\b/i },
  { candidate: /\btransfer\b/i, evidence: /\btransfer\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:sent|executed|completed)\b|\b(?:already|previously)\s+transferred\b/i },
  { candidate: /\bsubmit\b/i, evidence: /\b(?:form|application|submission)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?submitted\b|\b(?:already|previously)\s+submitted\b/i },
  { candidate: /\b(?:create|issue)\b/i, evidence: /\b(?:record|invoice|ticket|document)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:created|issued)\b/i },
  { candidate: /\b(?:execute|run)\b/i, evidence: /\b(?:job|task|command|workflow)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:executed|run|completed)\b/i },
  { candidate: /\b(?:charge|purchase|buy)\b/i, evidence: /\b(?:charge|purchase|order)\b\s+(?:was\s+)?(?:already\s+|previously\s+)?(?:charged|purchased|placed|completed)\b/i },
];

function identityKeys(text) {
  const keys = new Set();
  const upperCodes = text.match(/\b[A-Z]{1,6}[- ]?\d{2,}[A-Z0-9-]*\b/g) ?? [];
  for (const code of upperCodes) keys.add(code.replace(/\s+/g, "").toLowerCase());
  const labelled = /\b(employer|employee|invoice|flight|order|ticket|account|customer|request|job)\s+(?:#|id\s*[:=]?\s*)?([A-Za-z0-9-]{1,40})\b/gi;
  for (const match of text.matchAll(labelled)) keys.add(`${match[1].toLowerCase()}:${match[2].toLowerCase()}`);
  return keys;
}

function scopeKeys(text) {
  const keys = new Set(identityKeys(text));
  const months = text.toLowerCase().match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/g) ?? [];
  for (const month of months) keys.add(`month:${month}`);
  const years = text.match(/\b20\d{2}\b/g) ?? [];
  for (const year of years) keys.add(`year:${year}`);
  return keys;
}

function intersects(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function detectDuplicateSideEffect(input) {
  const contract = `${input.goal} ${input.constraints.join(" ")}`;
  if (!/(exactly\s+once|only\s+once|do\s+not\s+duplicate|no\s+duplicate)/i.test(contract)) return { findings: [], unknowns: [] };
  const family = ACTION_FAMILIES.find((item) => item.candidate.test(input.candidate));
  if (!family) return { findings: [], unknowns: [] };

  const candidateIds = identityKeys(input.candidate);
  const contractIds = identityKeys(contract);
  const targetIds = new Set([...candidateIds, ...contractIds]);
  const contractScope = scopeKeys(`${contract} ${input.candidate}`);
  const matching = [];
  let ambiguous = false;

  for (const evidence of input.evidence) {
    if (!family.evidence.test(evidence.text)) continue;
    const evidenceIds = identityKeys(evidence.text);
    const evidenceScope = scopeKeys(evidence.text);
    if (targetIds.size > 0 && evidenceIds.size === 0) {
      ambiguous = true;
      continue;
    }
    if (targetIds.size > 0 && evidenceIds.size > 0 && !intersects(targetIds, evidenceIds)) continue;
    if (!intersects(contractScope, evidenceScope)) {
      ambiguous = true;
      continue;
    }
    matching.push(evidence.id);
  }

  if (!matching.length) {
    return {
      findings: [],
      unknowns: ambiguous ? ["Evidence suggests a similar side effect may already exist, but target/scope identity is insufficient to prove a duplicate."] : [],
    };
  }
  return {
    findings: [finding({
      type: "duplicate_side_effect",
      severity: "critical",
      rule: "Side effect must occur exactly once.",
      observed: "Candidate proposes an action whose target/scope matches supplied evidence of the already-performed action.",
      evidenceRefs: matching,
      reason: "Executing the candidate risks duplicating the same already-completed side effect.",
    })],
    unknowns: [],
  };
}
function extractDates(text) {
  const values = new Map();
  for (const match of text.matchAll(ISO_DATE_RE)) {
    const value = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), raw: match[0] };
    values.set(`${value.year}-${value.month}-${value.day}`, value);
  }
  for (const match of text.matchAll(MONTH_DATE_RE)) {
    const monthKey = match[1].toLowerCase();
    const value = { year: match[3] ? Number(match[3]) : null, month: MONTHS[monthKey], day: Number(match[2]), raw: match[0] };
    if (!value.month) continue;
    values.set(`${value.year ?? "?"}-${value.month}-${value.day}`, value);
  }
  return [...values.values()];
}

function datesDefinitelyConflict(a, b) {
  if (a.month !== b.month || a.day !== b.day) return true;
  return a.year != null && b.year != null && a.year !== b.year;
}

const DATE_ANCHOR_GROUPS = Object.freeze({
  deadline: ["deadline", "due", "close", "closes", "closing", "submission", "submissions"],
  meeting: ["meeting", "appointment"],
  flight: ["flight", "departure", "arrival"],
  delivery: ["delivery", "deliver", "shipment"],
  launch: ["launch", "release"],
  event: ["event", "session", "arena"],
});

function anchorGroups(text) {
  const lower = text.toLowerCase();
  return Object.entries(DATE_ANCHOR_GROUPS)
    .filter(([, words]) => words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(lower)))
    .map(([name]) => name);
}

function dateKey(value) {
  return `${value.year ?? "?"}-${value.month}-${value.day}`;
}

function datesForAnchor(text, anchor) {
  const words = DATE_ANCHOR_GROUPS[anchor] ?? [];
  const dates = extractDates(text);
  if (!dates.length || !words.length) return [];
  const lower = text.toLowerCase();
  const positions = [];
  for (const word of words) {
    const re = new RegExp(`\\b${word}\\b`, "gi");
    for (const match of lower.matchAll(re)) positions.push(match.index ?? -9999);
  }
  return dates.filter((date) => {
    const idx = lower.indexOf(date.raw.toLowerCase());
    return positions.some((position) => Math.abs(position - idx) <= 80);
  });
}

function detectEvidenceDateContradiction(input) {
  const contractAnchors = anchorGroups(`${input.goal} ${input.constraints.join(" ")}`);
  if (!contractAnchors.length) return { findings: [], unknowns: [] };
  const findings = [];
  const unknowns = [];

  for (const anchor of contractAnchors) {
    const candidateDates = datesForAnchor(input.candidate, anchor);
    if (candidateDates.length !== 1) continue;
    const evidenceRows = [];
    for (const evidence of input.evidence) {
      const dates = datesForAnchor(evidence.text, anchor);
      if (dates.length === 1) evidenceRows.push({ evidence, date: dates[0] });
    }
    if (!evidenceRows.length) continue;
    const distinctEvidence = new Set(evidenceRows.map((row) => dateKey(row.date)));
    if (distinctEvidence.size > 1) {
      unknowns.push(`Supplied evidence conflicts about the ${anchor} date; refusing to accuse the candidate.`);
      continue;
    }
    const evidenceDate = evidenceRows[0].date;
    if (datesDefinitelyConflict(candidateDates[0], evidenceDate)) {
      findings.push(finding({
        type: "evidence_contradiction",
        severity: "high",
        rule: `Candidate should agree with supplied ${anchor} date evidence.`,
        observed: candidateDates[0].raw,
        evidenceRefs: evidenceRows.map((row) => row.evidence.id),
        reason: `Candidate ${anchor} date ${candidateDates[0].raw} conflicts with consistent supplied evidence date ${evidenceDate.raw}.`,
      }));
    }
  }
  return { findings, unknowns };
}
function detectInternalContradiction(candidate) {
  const lower = candidate.toLowerCase();
  // Conservative pattern: the same short proposition explicitly appears as both true and false.
  const yesNo = lower.match(/\b(?:is|are|was|were)\s+([a-z][a-z0-9 _-]{2,40})\b[\s\S]{0,120}\b(?:is|are|was|were)\s+not\s+\1\b/i)
    || lower.match(/\b(?:is|are|was|were)\s+not\s+([a-z][a-z0-9 _-]{2,40})\b[\s\S]{0,120}\b(?:is|are|was|were)\s+\1\b/i);
  if (!yesNo) return [];
  return [finding({
    type: "internal_contradiction",
    severity: "high",
    rule: "Candidate must be internally consistent.",
    observed: yesNo[0],
    reason: "Candidate contains directly contradictory statements.",
  })];
}

export function deterministicCheck(input) {
  const findings = [];
  const unknowns = [];
  const materialUnknowns = [];
  const handoffUnknowns = [];
  const requirements = [];
  let checksRun = 0;

  checksRun += 1;
  const injectionLocations = [];
  if (INJECTION_PATTERNS.some((re) => re.test(input.candidate))) injectionLocations.push("candidate");
  for (const evidence of input.evidence) {
    if (INJECTION_PATTERNS.some((re) => re.test(evidence.text))) injectionLocations.push(`evidence:${evidence.id}`);
  }
  if (injectionLocations.length) {
    findings.push(finding({
      type: "untrusted_instruction_detected",
      severity: "low",
      rule: "Candidate/evidence are data, not verifier instructions.",
      observed: injectionLocations.join(", "),
      reason: "Instruction-like content was detected and treated as untrusted data.",
    }));
  }

  for (let i = 0; i < input.constraints.length; i += 1) {
    const constraint = input.constraints[i];
    checksRun += 1;
    const result = evaluateNumericConstraint(constraint, input.candidate)
      ?? evaluateTextConstraint(constraint, input.candidate)
      ?? evaluateDirectnessConstraint(constraint, input.candidate);
    if (!result) {
      requirements.push({ id: `C${i + 1}`, constraint_index: i, requirement: constraint, status: "UNKNOWN", reason: "No deterministic evaluator matched this constraint." });
      const message = `Constraint C${i + 1} requires semantic verification.`;
      unknowns.push(message);
      handoffUnknowns.push(message);
      continue;
    }
    if (result.finding) findings.push({ id: `D${findings.length + 1}`, ...result.finding });
    requirements.push({ id: `C${i + 1}`, constraint_index: i, requirement: constraint, status: result.status, reason: result.reason ?? result.finding?.reason ?? "" });
  }

  checksRun += 1;
  const duplicateCheck = detectDuplicateSideEffect(input);
  for (const f of duplicateCheck.findings) findings.push({ id: `D${findings.length + 1}`, ...f });
  unknowns.push(...duplicateCheck.unknowns);
  materialUnknowns.push(...duplicateCheck.unknowns);

  checksRun += 1;
  const dateCheck = detectEvidenceDateContradiction(input);
  for (const f of dateCheck.findings) findings.push({ id: `D${findings.length + 1}`, ...f });
  unknowns.push(...dateCheck.unknowns);
  materialUnknowns.push(...dateCheck.unknowns);

  checksRun += 1;
  for (const f of detectInternalContradiction(input.candidate)) findings.push({ id: `D${findings.length + 1}`, ...f });

  const criticalFinding = findings.some((f) => ["critical", "high"].includes(f.severity) && f.type !== "untrusted_instruction_detected");
  return {
    source: "deterministic",
    checks_run: checksRun,
    requirements,
    findings,
    unknowns,
    material_unknowns: materialUnknowns,
    handoff_unknowns: handoffUnknowns,
    critical_finding: criticalFinding,
  };
}
