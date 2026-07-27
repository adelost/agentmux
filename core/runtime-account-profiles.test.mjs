import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import {
  accountEngineForCommand,
  beginRuntimeProfileTransition,
  completeRuntimeProfileTransition,
  pendingRuntimeProfile,
  prepareRuntimeProfile,
  selectedRuntimeProfile,
  setRuntimeProfile,
} from "./runtime-account-profiles.mjs";

const stateStore = () => {
  const values = {};
  return {
    get: (key, fallback) => values[key] ?? fallback,
    set: (key, value) => { values[key] = value; },
  };
};

feature("runtime account profiles", () => {
  unit("config selects a profile until durable pane state overrides it", {
    given: ["two Claude profiles and pane config", () => {
      const state = stateStore();
      const catalog = [
        { provider: "claude", id: "1", home: "/profiles/1" },
        { provider: "claude", id: "2", home: "/profiles/2" },
      ];
      return { state, catalog, paneConfig: { cmd: "claude --continue", accountProfile: 2 } };
    }],
    when: ["reading, setting profile 1, and reading again", (ctx) => {
      const configured = selectedRuntimeProfile({
        ...ctx, agentName: "lsrc", pane: 3, provider: "claude",
      });
      setRuntimeProfile(ctx.state, "lsrc", 3, "claude", "1");
      const persisted = selectedRuntimeProfile({
        ...ctx, agentName: "lsrc", pane: 3, provider: "claude",
      });
      return { configured, persisted };
    }],
    then: ["durable state wins deterministically", ({ configured, persisted }) => {
      expect(configured.id).toBe("2");
      expect(persisted.id).toBe("1");
    }],
  });

  unit("secondary Claude auth shares history without sharing credentials", {
    given: ["two empty profile homes", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-account-profile-"));
      const primary = {
        provider: "claude", id: "1", home: join(root, "one"),
        credentialsPath: join(root, "one", ".credentials.json"),
      };
      const secondary = {
        provider: "claude", id: "2", home: join(root, "two"),
        credentialsPath: join(root, "two", ".credentials.json"),
      };
      mkdirSync(primary.home, { recursive: true });
      writeFileSync(primary.credentialsPath, '{"accessToken":"one"}');
      return { root, primary, secondary };
    }],
    when: ["preparing profile 2", (ctx) => {
      prepareRuntimeProfile(ctx.secondary, [ctx.primary, ctx.secondary]);
      return ctx;
    }],
    then: ["projects is shared but credentials remain absent", (ctx) => {
      expect(readlinkSync(join(ctx.secondary.home, "projects")))
        .toBe(join(ctx.primary.home, "projects"));
      expect(() => readlinkSync(ctx.secondary.credentialsPath)).toThrow();
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("engine detection covers all supported coding clients", {
    when: ["classifying commands", () => [
      accountEngineForCommand("claude --continue"),
      accountEngineForCommand("codex --yolo"),
      accountEngineForCommand("/home/u/.kimi-code/bin/kimi --auto"),
      accountEngineForCommand("bash"),
    ]],
    then: ["only coding clients receive account semantics", (engines) => {
      expect(engines).toEqual(["claude", "codex", "kimi", null]);
    }],
  });

  unit("restart intent survives until the verified profile is stored", {
    given: ["an isolated pane state", () => ({ state: stateStore() })],
    when: ["beginning and completing one exact transition", (ctx) => {
      const transition = beginRuntimeProfileTransition(ctx.state, {
        agentName: "lsrc",
        pane: 3,
        provider: "claude",
        previousProfileId: "1",
        targetProfileId: "2",
        sessionId: "11111111-1111-4111-8111-111111111111",
      });
      ctx.pending = pendingRuntimeProfile(ctx.state, "lsrc", 3);
      completeRuntimeProfileTransition(ctx.state, transition, "2");
      ctx.after = pendingRuntimeProfile(ctx.state, "lsrc", 3);
      return ctx;
    }],
    then: ["intent is durable before restart and cleared only with selection", (ctx) => {
      expect(ctx.pending).toMatchObject({ targetProfileId: "2" });
      expect(ctx.after).toBeNull();
      expect(ctx.state.get("account_profile_by_pane_v1", {})["lsrc:3"]).toBe("2");
    }],
  });
});
