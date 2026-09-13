import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadOrganizerAuditSink } from "../src/sharedos/audit.js";

const failures = [];
const warnings = [];
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 11)) failures.push(`Node ${process.versions.node} is below required 20.11`);

const value = (name) => (process.env[name] ?? "").trim();
const looksPlaceholder = (text) => !text || /^<.*>$/u.test(text) || /^(changeme|replace[-_ ]?me|todo|example|placeholder)$/iu.test(text);
const intValue = (name, fallback) => {
  const parsed = Number.parseInt(value(name), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

function git(args) {
  return spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
}

function normalizeRepoUrl(raw) {
  return raw.trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

async function importModule(modulePath, label, timeoutMs = 5_000) {
  const specifier = modulePath.startsWith(".") || path.isAbsolute(modulePath)
    ? pathToFileURL(path.resolve(modulePath)).href
    : modulePath;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} initialization timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try { return await Promise.race([import(specifier), timeout]); }
  finally { clearTimeout(timer); }
}

if (!/^(1|true|yes|on)$/i.test(value("REQUIRE_SHAREDOS"))) failures.push("REQUIRE_SHAREDOS must be true for Arena");
if (value("CRITIC_PROVIDER").toLowerCase() !== "llm") failures.push("CRITIC_PROVIDER must be llm for Arena");

const apiKey = value("LLM_API_KEY");
if (looksPlaceholder(apiKey)) failures.push("LLM_API_KEY is missing or still a placeholder");
const model = value("LLM_MODEL");
if (looksPlaceholder(model)) failures.push("LLM_MODEL is missing or still a placeholder");

const baseUrl = value("LLM_BASE_URL");
try {
  const parsed = new URL(baseUrl);
  if (!/^https?:$/u.test(parsed.protocol)) failures.push("LLM_BASE_URL must use http or https");
} catch { failures.push("LLM_BASE_URL is not a valid URL"); }

const namespace = value("AGENTPROOF_NAMESPACE");
if (looksPlaceholder(namespace) || namespace === "agentproof-arena") failures.push("AGENTPROOF_NAMESPACE must be the organizer-issued tenant/namespace, not the local default");

const ownerJson = value("AGENTPROOF_OWNER_ADDRESS_JSON");
if (looksPlaceholder(ownerJson)) {
  failures.push("AGENTPROOF_OWNER_ADDRESS_JSON must be the exact organizer-issued SharedOS owner address JSON");
} else {
  try {
    const owner = JSON.parse(ownerJson);
    const field = { human: "userId", agent: "agentId", group: "conversationId", service: "serviceId" }[owner?.kind];
    if (!field || typeof owner[field] !== "string" || !owner[field].trim()) failures.push("AGENTPROOF_OWNER_ADDRESS_JSON is not a valid SharedOS address");
  } catch { failures.push("AGENTPROOF_OWNER_ADDRESS_JSON is not valid JSON"); }
}

const auditModule = value("SHAREDOS_AUDIT_SINK_MODULE");
if (looksPlaceholder(auditModule)) {
  failures.push("SHAREDOS_AUDIT_SINK_MODULE is missing");
} else {
  try {
    if ((auditModule.startsWith(".") || path.isAbsolute(auditModule)) && fs.existsSync(path.resolve(auditModule))) {
      const source = fs.readFileSync(path.resolve(auditModule), "utf8");
      if (/still a template|ORGANIZER INTEGRATION START[\s\S]*throw new Error/i.test(source)) failures.push("Organizer audit module is still the fail-closed template");
    }
    await loadOrganizerAuditSink(auditModule, { timeoutMs: intValue("ORGANIZER_AUDIT_INIT_TIMEOUT_MS", 5_000) });
  } catch (error) {
    failures.push(`Organizer audit module cannot be initialized: ${error instanceof Error ? error.message : error}`);
  }
}

const nodeId = value("SHAREDNET_NODE_ID");
if (looksPlaceholder(nodeId)) failures.push("SHAREDNET_NODE_ID is missing or still a placeholder");

const sharednetModule = value("SHAREDNET_ADAPTER_MODULE");
if (looksPlaceholder(sharednetModule)) {
  failures.push("SHAREDNET_ADAPTER_MODULE is missing");
} else {
  try {
    if ((sharednetModule.startsWith(".") || path.isAbsolute(sharednetModule)) && fs.existsSync(path.resolve(sharednetModule))) {
      const source = fs.readFileSync(path.resolve(sharednetModule), "utf8");
      if (/still a template|ORGANIZER SHAREDNET INTEGRATION START[\s\S]*throw new Error/i.test(source)) failures.push("SharedNet adapter module is still the fail-closed template");
    }
    const mod = await importModule(sharednetModule, "SharedNet adapter", intValue("SHAREDNET_INIT_TIMEOUT_MS", 8_000));
    const adapter = mod.sharedNetAdapter ?? (typeof mod.createSharedNetAdapter === "function" ? await Promise.race([
      Promise.resolve(mod.createSharedNetAdapter({ signal: new AbortController().signal })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SharedNet adapter factory timed out")), intValue("SHAREDNET_INIT_TIMEOUT_MS", 8_000))),
    ]) : null);
    if (!adapter?.registerService || !adapter?.callService) failures.push("SharedNet adapter must expose registerService(...) and callService(...)");
  } catch (error) {
    failures.push(`SharedNet adapter cannot be initialized: ${error instanceof Error ? error.message : error}`);
  }
}

try { await import("@aicoo/sharedos"); }
catch (error) { failures.push(`@aicoo/sharedos cannot be imported: ${error instanceof Error ? error.message : error}`); }

if (!fs.existsSync(path.resolve("package-lock.json"))) failures.push("package-lock.json is missing; run npm install and commit the lockfile");
if (!fs.existsSync(path.resolve(".git"))) failures.push("Git repository is not initialized");
else {
  const status = git(["status", "--porcelain"]);
  if (status.status !== 0) failures.push("git status could not be read");
  else if (status.stdout.trim()) failures.push("Git working tree is not clean; commit the Arena candidate before final preflight");

  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0 || !/^[0-9a-f]{40}\s*$/iu.test(head.stdout)) failures.push("Git HEAD commit could not be resolved");

  const origin = git(["remote", "get-url", "origin"]);
  if (origin.status !== 0 || !origin.stdout.trim()) failures.push("Git remote 'origin' is missing; final source must be published");
  const submissionRepo = value("SUBMISSION_REPO_URL");
  if (looksPlaceholder(submissionRepo)) failures.push("SUBMISSION_REPO_URL is missing; set it to the public repository submitted to Devpost");
  else if (origin.status === 0 && normalizeRepoUrl(origin.stdout) !== normalizeRepoUrl(submissionRepo)) failures.push("SUBMISSION_REPO_URL does not match git remote origin");

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0 || branch.stdout.trim() === "HEAD") failures.push("Arena candidate must be on a named Git branch, not detached HEAD");

  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.status !== 0 || !upstream.stdout.trim()) {
    failures.push("Current Git branch has no upstream; push it with -u before final preflight");
  } else {
    const counts = git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts.status !== 0) failures.push("Could not compare local HEAD with upstream");
    else {
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      if (ahead > 0) failures.push(`Local Arena branch has ${ahead} unpushed commit(s)`);
      if (behind > 0) warnings.push(`Local Arena branch is ${behind} commit(s) behind upstream`);
    }
  }
}

const listingPath = path.resolve("SERVICE_LISTING.md");
if (!fs.existsSync(listingPath)) failures.push("SERVICE_LISTING.md is missing");
else {
  const listing = fs.readFileSync(listingPath, "utf8");
  if (/Replace this paragraph with the exact SharedNet call syntax/i.test(listing)) failures.push("SERVICE_LISTING.md still contains the SharedNet call-syntax placeholder");
  if (!/verify_before_commit/u.test(listing)) failures.push("SERVICE_LISTING.md does not name verify_before_commit");
}

if (!fs.existsSync(path.resolve(".env.arena"))) warnings.push(".env.arena file is absent; use .env.arena.example as the template");

if (warnings.length) {
  console.warn("ARENA PREFLIGHT WARNINGS");
  for (const warning of warnings) console.warn(`- ${warning}`);
}
if (failures.length) {
  console.error("ARENA PREFLIGHT: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("ARENA PREFLIGHT: PASS");
