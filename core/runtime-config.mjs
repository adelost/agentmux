import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { regenerateAgentsYaml } from "../sync.mjs";

/**
 * WHAT: Builds one generated pane config from the user-owned source file.
 * WHY: Prevents CLI, headless broker, and Discord from reading different fleet truths.
 */
export function materializeRuntimeConfig({ sourcePath, generatedPath }) {
  if (!existsSync(sourcePath)) throw new Error(`agentmux.yaml not found at ${sourcePath}`);
  const source = readFileSync(sourcePath, "utf8");
  const existing = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
  const next = regenerateAgentsYaml(source, existing);
  if (next === existing) return { path: generatedPath, changed: false };
  mkdirSync(dirname(generatedPath), { recursive: true, mode: 0o700 });
  const temporary = `${generatedPath}.${process.pid}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, generatedPath);
  chmodSync(generatedPath, 0o600);
  return { path: generatedPath, changed: true };
}

/**
 * WHAT: Resolves a generated config from source or an explicit legacy file.
 * WHY: Keeps upgraded installations working while new installs use one source truth.
 */
export function ensureRuntimeConfig({ sourcePath, generatedPath }) {
  if (existsSync(sourcePath)) return materializeRuntimeConfig({ sourcePath, generatedPath });
  if (existsSync(generatedPath)) return { path: generatedPath, changed: false, legacy: true };
  throw new Error(`agentmux.yaml not found at ${sourcePath}`);
}
