import { describe, expect, it } from "vitest";
import { parseRuntimeEnv, resolveRuntimeEnv } from "./runtime-env.mjs";

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
});
