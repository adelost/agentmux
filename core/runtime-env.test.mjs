import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeEnv, parseRuntimeEnv, resolveRuntimeEnv } from "./runtime-env.mjs";

describe("runtime env", () => {
  it("parses bounded dotenv assignments and ignores non-assignments", () => {
    expect(parseRuntimeEnv("A=one\nexport B='two words'\n# C=no\nbad-key=x\n")).toEqual({
      A: "one",
      B: "two words",
    });
  });

  it("lets user config override package defaults while explicit env wins", () => {
    expect(resolveRuntimeEnv({
      packageText: "LINK_BASE=https://package.example\nVOICE_PWA_PORT=8080",
      userText: "LINK_BASE=https://user.example\nLINK_TARGETS_WSL=lsrc:3",
      explicit: { VOICE_PWA_PORT: "3939" },
    })).toEqual({
      LINK_BASE: "https://user.example",
      LINK_TARGETS_WSL: "lsrc:3",
      VOICE_PWA_PORT: "3939",
    });
  });

  it("honors an explicitly configured external env file", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-env-"));
    const packageRoot = join(root, "package");
    const explicitPath = join(root, "operator.env");
    mkdirSync(packageRoot);
    writeFileSync(join(packageRoot, ".env"), "VALUE=package\n");
    writeFileSync(explicitPath, "VALUE=operator\n");
    const processEnv = { AMUX_DISCORD_ENV: explicitPath };
    try {
      expect(loadRuntimeEnv({ packageRoot, userHome: join(root, "home"), processEnv }).VALUE)
        .toBe("operator");
    }
    finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
