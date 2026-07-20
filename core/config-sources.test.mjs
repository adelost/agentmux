import { describe, expect, it } from "vitest";
import { resolveConfigSources } from "./config-sources.mjs";

describe("config sources", () => {
  const packageDir = "/pkg";

  it("prefers the explicit env path, then the external home, then the package fallback", () => {
    const everywhere = (path) => ["/home/u/.agentmux/.env", "/home/u/.agentmux/agentmux.yaml"].includes(path);
    expect(resolveConfigSources({
      env: { AMUX_DISCORD_ENV: "/pinned/secrets.env", AGENTMUX_YAML: "/pinned/agentmux.yaml" },
      home: "/home/u",
      packageDir,
      exists: everywhere,
    })).toEqual({
      envFile: { path: "/pinned/secrets.env", source: "env" },
      agentmuxYaml: { path: "/pinned/agentmux.yaml", source: "env" },
    });

    expect(resolveConfigSources({
      env: {}, home: "/home/u", packageDir, exists: everywhere,
    })).toEqual({
      envFile: { path: "/home/u/.agentmux/.env", source: "home" },
      agentmuxYaml: { path: "/home/u/.agentmux/agentmux.yaml", source: "home" },
    });

    // No env, no home files: the pre-migration package copy still works.
    expect(resolveConfigSources({
      env: {}, home: "/home/u", packageDir, exists: () => false,
    })).toEqual({
      envFile: { path: "/pkg/.env", source: "package-fallback" },
      agentmuxYaml: { path: "/pkg/agentmux.yaml", source: "package-fallback" },
    });
  });
});
