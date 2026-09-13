import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(label, args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result;
}

try {
  run("Arena preflight", ["scripts/arena-preflight.js"]);

  const testFiles = fs.readdirSync(path.resolve("tests"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("tests", name));
  const tests = run("Arena test suite", ["--test", ...testFiles], { capture: true });
  const skippedMatch = tests.stdout.match(/^# skipped\s+(\d+)$/m);
  if (!skippedMatch) throw new Error("Could not verify skipped-test count from Node test output");
  const skipped = Number.parseInt(skippedMatch[1], 10);
  if (skipped !== 0) throw new Error(`Arena requires zero skipped tests; found ${skipped}`);

  run("Arena benchmark", ["scripts/bench.js"]);
  run("Arena live SharedNet load/probe", ["scripts/arena-load.js"]);
  console.log("ARENA CHECK: PASS");
} catch (error) {
  console.error("ARENA CHECK: FAIL");
  console.error(`- ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
