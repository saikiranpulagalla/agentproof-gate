import { spawnSync } from "node:child_process";

const preflight = spawnSync(process.execPath, ["scripts/arena-preflight.js"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (preflight.error) throw preflight.error;
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const { config } = await import("../src/config.js");
const { createAgentProofServer } = await import("../src/server.js");
const { server, service } = await createAgentProofServer(config);
server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "agentproof.arena.started", port: config.port, health: service.health() }));
});
