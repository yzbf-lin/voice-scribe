#!/usr/bin/env node
/**
 * Launches Electron with a clean environment.
 *
 * Some toolchains (and IDE terminals) export ELECTRON_RUN_AS_NODE=1, which makes
 * Electron behave like plain Node and breaks `require("electron").app`. We strip
 * it here so `npm run dev` works everywhere.
 */
const { spawn } = require("node:child_process");

const electronPath = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const extraArgs = process.argv.slice(2);

// Chromium's own sandbox cannot initialise inside another sandbox (agent shells,
// CI containers): it fails with "sandbox initialization failed: Operation not
// permitted" and the GPU process dies. Set VS_NO_SANDBOX=1 to opt out.
if (process.env.VS_NO_SANDBOX === "1" && !extraArgs.includes("--no-sandbox")) {
  extraArgs.push("--no-sandbox");
}

const child = spawn(electronPath, [".", ...extraArgs], {
  stdio: "inherit",
  env,
});

child.on("close", (code) => process.exit(code ?? 0));
