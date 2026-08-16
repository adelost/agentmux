import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** WHAT: Parses the small dotenv subset used by Agentmux runtime config. WHY: Keeps secrets out of shell command lines. */
export function parseRuntimeEnv(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.trim().replace(/^export\s+/u, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** WHAT: Resolves package defaults, user config and explicit process env. WHY: Makes restarts preserve Link without overriding operator flags. */
export function resolveRuntimeEnv({ packageText = "", userText = "", explicit = {} } = {}) {
  return {
    ...parseRuntimeEnv(packageText),
    ...parseRuntimeEnv(userText),
    ...explicit,
  };
}

/** WHAT: Loads release-pinned and user-owned runtime config before index.mjs. WHY: A supervised restart must not silently disable Link. */
export function loadRuntimeEnv({
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  userHome = homedir(),
  processEnv = process.env,
} = {}) {
  const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : "";
  const userEnvPath = processEnv.AMUX_DISCORD_ENV
    || join(userHome, ".agentmux", ".env");
  const resolved = resolveRuntimeEnv({
    packageText: read(join(packageRoot, ".env")),
    userText: read(userEnvPath),
    explicit: { ...processEnv },
  });
  Object.assign(processEnv, resolved);
  return resolved;
}
