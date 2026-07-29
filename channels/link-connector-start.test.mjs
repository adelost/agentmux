import { component, expect, feature } from "bdd-vitest";
import { startLinkConnectorIfConfigured } from "./link-connector-start.mjs";

feature("Link connector starter", () => {
  component("the configured connector receives the shared transcriber", {
    given: ["connector env and an injected cycle", () => {
      const before = {
        base: process.env.LINK_BASE,
        token: process.env.LINK_TOKEN_WSL,
        targets: process.env.LINK_TARGETS_WSL,
      };
      process.env.LINK_BASE = "https://link.v1d.io";
      process.env.LINK_TOKEN_WSL = "secret";
      process.env.LINK_TARGETS_WSL = "lsrc:3,lsrc:10";
      const seen = [];
      const transcribe = async () => "text";
      return { before, seen, transcribe };
    }],
    when: ["starting its scheduled cycle", async (ctx) => {
      const started = startLinkConnectorIfConfigured({
        agent: {},
        deliveryBroker: {},
        deliveryQueue: {},
        transcribe: ctx.transcribe,
        runCycle: async (deps) => { ctx.seen.push(deps); },
        scheduleTimeout: (callback) => callback(),
        scheduleInterval: () => {},
        log: () => {},
      });
      await Promise.resolve();
      return { started, ctx };
    }],
    then: ["the exact function and declarative targets reach the cycle", ({ started, ctx }) => {
      expect(started).toBe(true);
      expect(ctx.seen).toHaveLength(1);
      expect(ctx.seen[0].transcribe).toBe(ctx.transcribe);
      expect(ctx.seen[0].targets).toEqual(["lsrc:3", "lsrc:10"]);
      for (const [key, value] of Object.entries({
        LINK_BASE: ctx.before.base,
        LINK_TOKEN_WSL: ctx.before.token,
        LINK_TARGETS_WSL: ctx.before.targets,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }],
  });
});
