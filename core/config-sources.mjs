// External config/secret source resolution.
//
// Secrets and operator config must survive `npm install --global` replacing
// the package tree (the 2026-07-20 .env wipe). The explicit external home
// (~/.agentmux) is the primary source; a package-directory copy remains only
// as the migration fallback for installs that predate the home files.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const AMUX_ENV_VAR = "AMUX_DISCORD_ENV";

/** WHAT: Resolves the .env and agentmux.yaml source paths. WHY: One pinned contract; package copies are fallback, never the only path to credentials. */
export function resolveConfigSources({
  env = process.env,
  home = homedir(),
  packageDir,
  exists = existsSync,
} = {}) {
  const homeDir = join(home, ".agentmux");
  const pick = (envValue, homePath, packagePath) => {
    if (envValue) return { path: envValue, source: "env" };
    if (exists(homePath)) return { path: homePath, source: "home" };
    return { path: packagePath, source: "package-fallback" };
  };
  return {
    envFile: pick(env[AMUX_ENV_VAR], join(homeDir, ".env"), join(packageDir, ".env")),
    agentmuxYaml: pick(env.AGENTMUX_YAML, join(homeDir, "agentmux.yaml"), join(packageDir, "agentmux.yaml")),
  };
}
