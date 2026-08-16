#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigSources } from "../core/config-sources.mjs";
import { materializeRuntimeConfig } from "../core/runtime-config.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRuntimeEnv({ packageRoot: root });
const sources = resolveConfigSources({ packageDir: root });
const result = materializeRuntimeConfig({
  sourcePath: process.argv[2] || sources.agentmuxYaml.path,
  generatedPath: process.argv[3] || runtimeAgentsPath(process.env, homedir()),
});
console.log(`${result.changed ? "generated" : "verified"} ${result.path}`);
