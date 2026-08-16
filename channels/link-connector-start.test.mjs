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
      const scheduled = [];
      const started = startLinkConnectorIfConfigured({
        agent: {},
        deliveryBroker: {},
        deliveryQueue: {},
        transcribe: ctx.transcribe,
        runCycle: async (deps) => { ctx.seen.push(deps); },
        scheduleTimeout: (callback, delayMs) => scheduled.push({ callback, delayMs }),
        log: () => {},
      });
      const initial = scheduled.shift();
      await initial.callback();
      return { started, ctx, initial, scheduled };
    }],
    then: ["the exact function and declarative targets reach the cycle", ({ started, ctx, initial, scheduled }) => {
      expect(started).toBe(true);
      expect(initial.delayMs).toBe(20_000);
      expect(ctx.seen).toHaveLength(1);
      expect(ctx.seen[0].transcribe).toBe(ctx.transcribe);
      expect(ctx.seen[0].targets).toEqual(["lsrc:3", "lsrc:10"]);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].delayMs).toBe(15_000);
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

  component("a slow cycle must finish before another poll is scheduled", {
    given: ["one configured connector and a held-open cycle", () => {
      const before = {
        base: process.env.LINK_BASE,
        token: process.env.LINK_TOKEN_WSL,
        targets: process.env.LINK_TARGETS_WSL,
      };
      process.env.LINK_BASE = "https://link.v1d.io";
      process.env.LINK_TOKEN_WSL = "secret";
      process.env.LINK_TARGETS_WSL = "project:1";
      const scheduled = [];
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let cycles = 0;
      return { before, scheduled, held, release: () => release(), cycles: () => cycles, increment: () => { cycles += 1; } };
    }],
    when: ["the initial timer fires while its cycle remains open", async (ctx) => {
      startLinkConnectorIfConfigured({
        agent: {},
        deliveryBroker: {},
        deliveryQueue: {},
        transcribe: async () => "text",
        runCycle: async () => {
          ctx.increment();
          await ctx.held;
        },
        scheduleTimeout: (callback, delayMs) => ctx.scheduled.push({ callback, delayMs }),
        log: () => {},
      });
      const first = ctx.scheduled.shift().callback();
      await Promise.resolve();
      const whileOpen = ctx.scheduled.length;
      ctx.release();
      await first;
      return { ctx, whileOpen };
    }],
    then: ["no overlapping tick exists and one next poll appears only after completion", ({ ctx, whileOpen }) => {
      expect(ctx.cycles()).toBe(1);
      expect(whileOpen).toBe(0);
      expect(ctx.scheduled).toHaveLength(1);
      expect(ctx.scheduled[0].delayMs).toBe(15_000);
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

  component("credentialed remote Link endpoints require HTTPS", {
    given: ["a plaintext remote endpoint", () => {
      const before = {
        base: process.env.LINK_BASE,
        token: process.env.LINK_TOKEN_WSL,
        targets: process.env.LINK_TARGETS_WSL,
      };
      process.env.LINK_BASE = "http://link.example";
      process.env.LINK_TOKEN_WSL = "secret";
      process.env.LINK_TARGETS_WSL = "project:1";
      return before;
    }],
    when: ["starting the connector", (before) => {
      let message = "no error";
      try {
        startLinkConnectorIfConfigured({ transcribe: async () => "text" });
      } catch (error) {
        message = error.message;
      }
      for (const [key, value] of Object.entries({
        LINK_BASE: before.base,
        LINK_TOKEN_WSL: before.token,
        LINK_TARGETS_WSL: before.targets,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return message;
    }],
    then: ["the transport boundary rejects it", (message) => {
      expect(message).toContain("must use HTTPS");
    }],
  });
});
