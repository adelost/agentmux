import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { regenerateAgentsYaml } from "../sync.mjs";

/** WHAT: Resolves the user-owned source configuration. WHY: Keeps command writes away from generated runtime state. */
export function sourceConfigPath(ctx) {
  if (ctx.sourceConfigPath) return ctx.sourceConfigPath;
  // Library consumers from before the source/runtime split only supplied the
  // package root. Keep those embedded callers working while the CLI always
  // pins the operator-owned path explicitly.
  if (ctx.bridgeDir) return join(ctx.bridgeDir, "agentmux.yaml");
  throw new Error("source config path missing; agent-cli.mjs should set it");
}

/** WHAT: Parses the source configuration. WHY: Keeps mutating commands on one validation boundary. */
export function loadSourceYaml(ctx) {
  const path = sourceConfigPath(ctx);
  if (!existsSync(path)) throw new Error(`agentmux.yaml not found at ${path}`);
  const doc = yaml.load(readFileSync(path, "utf8"));
  if (!doc || typeof doc !== "object") {
    throw new Error(`agentmux.yaml is empty or malformed at ${path}`);
  }
  return doc;
}

/**
 * WHAT: Saves source configuration and regenerates the internal runtime view.
 * WHY: Keeps source mutations and the runtime view from drifting apart.
 */
export function saveSourceAndRegenerate(ctx, sourceDoc) {
  const srcYaml = yaml.dump(sourceDoc, { lineWidth: -1, quotingType: '"' });
  writeFileSync(sourceConfigPath(ctx), srcYaml);
  const existing = existsSync(ctx.configPath) ? readFileSync(ctx.configPath, "utf8") : null;
  writeFileSync(ctx.configPath, regenerateAgentsYaml(srcYaml, existing));
}
