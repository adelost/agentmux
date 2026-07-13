import { feature, component, e2e, unit, expect } from "bdd-vitest";
import { spawn } from "child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, utimesSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  discordMessagePayload,
  formatUserNotification,
  notificationNonce,
  resolveNotifyUserId,
  sendFileToChannelId,
  sendToChannelId,
} from "../cli/send-notify.mjs";

feature("notifyuser helpers", () => {
  component("sends the first explicit identity once and dedupes it across reloads", {
    given: ["empty durable state and a mocked Discord channel", () => {
      const oldHome = process.env.HOME;
      const oldToken = process.env.DISCORD_TOKEN;
      const oldNotify = process.env.AMUX_NOTIFY_USER_ID;
      const oldNotifyDiscord = process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      const oldFetch = global.fetch;
      const home = mkdtempSync(join(tmpdir(), "amux-notify-idempotency-"));
      mkdirSync(join(home, ".openclaw"), { recursive: true });
      writeFileSync(join(home, ".openclaw/.channel-cache.json"), JSON.stringify({ notify: "channel-1" }));
      process.env.HOME = home;
      process.env.DISCORD_TOKEN = "test-token";
      delete process.env.AMUX_NOTIFY_USER_ID;
      delete process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push({ url, payload: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ id: "message-1" }) };
      };
      return { calls, home, oldFetch, oldHome, oldNotify, oldNotifyDiscord, oldToken };
    }],
    when: ["notifying twice and retrying after a module reload", async (ctx) => {
      const identity = "suggestions-comment-notify:skydive:SKY-10:7";
      const firstModule = await import("../cli/send-notify.mjs?notify-first");
      const first = await firstModule.notifyUser("unanswered", { idempotencyKey: identity });
      const second = await firstModule.notifyUser("unanswered", { idempotencyKey: identity });
      const reloadedModule = await import("../cli/send-notify.mjs?notify-reload");
      const afterReload = await reloadedModule.notifyUser("unanswered", { idempotencyKey: identity });
      const state = JSON.parse(readFileSync(join(ctx.home, ".openclaw/.notifyuser-state.json"), "utf8"));
      return { ...ctx, afterReload, first, second, state };
    }],
    then: ["the first call posts and persists while both retries are deduped", ({
      afterReload, calls, first, second, state,
    }) => {
      expect(first).toMatchObject({ sent: true, target: "notify" });
      expect(second).toMatchObject({ sent: false, deduped: true });
      expect(afterReload).toMatchObject({ sent: false, deduped: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].payload).toMatchObject({ enforce_nonce: true });
      expect(Object.values(state)).toHaveLength(1);
      expect(Object.values(state)[0]).toEqual(expect.any(Number));
    }],
    cleanup: async ({ home, oldFetch, oldHome, oldNotify, oldNotifyDiscord, oldToken }) => {
      global.fetch = oldFetch;
      process.env.HOME = oldHome;
      if (oldToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = oldToken;
      if (oldNotify === undefined) delete process.env.AMUX_NOTIFY_USER_ID;
      else process.env.AMUX_NOTIFY_USER_ID = oldNotify;
      if (oldNotifyDiscord === undefined) delete process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      else process.env.AMUX_NOTIFY_USER_DISCORD_ID = oldNotifyDiscord;
      rmSync(home, { recursive: true, force: true });
    },
  });

  e2e("recovers a stale reused-PID claim and atomically merges concurrent receipts", {
    given: ["one stale live-PID claim and an empty HOME shared by concurrent processes", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-notify-multiprocess-"));
      mkdirSync(join(home, ".openclaw"), { recursive: true });
      writeFileSync(join(home, ".openclaw/.channel-cache.json"), JSON.stringify({ notify: "channel-1" }));
      const lockDir = join(home, ".openclaw/.notifyuser-state.json.lock.d");
      mkdirSync(lockDir, { recursive: true });
      const staleClaim = join(lockDir, "stale-reused-live-pid.claim");
      writeFileSync(staleClaim, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }));
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(staleClaim, staleTime, staleTime);
      const moduleUrl = new URL("../cli/send-notify.mjs", import.meta.url).href;
      const identities = Array.from({ length: 12 }, (_, index) => `suggestions-comment-notify:test:T-${index}:1`);
      return { home, identities, lockDir, moduleUrl };
    }],
    when: ["all identities notify concurrently and then retry in fresh processes", async (ctx) => {
      const run = (identities, rejectFetch) => new Promise((resolvePromise, reject) => {
        const script = [
          `global.fetch = async () => ${rejectFetch
            ? "{ throw new Error('deduped retry reached Discord'); }"
            : "({ ok: true, json: async () => ({ id: 'message-1' }) })"};`,
          `const { notifyUser } = await import(${JSON.stringify(ctx.moduleUrl)});`,
          "const identities = JSON.parse(process.env.TEST_IDENTITIES);",
          "const results = [];",
          "for (const identity of identities) results.push(await notifyUser('unanswered', { idempotencyKey: identity }));",
          "process.stdout.write(JSON.stringify(results));",
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: {
            ...process.env,
            HOME: ctx.home,
            DISCORD_TOKEN: "test-token",
            AMUX_NOTIFY_USER_ID: "",
            AMUX_NOTIFY_USER_DISCORD_ID: "",
            TEST_IDENTITIES: JSON.stringify(identities),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) reject(new Error(`notify child exited ${code}: ${stderr}`));
          else resolvePromise(JSON.parse(stdout));
        });
      });

      const firstProcesses = await Promise.all(ctx.identities.map((identity) => run([identity], false)));
      const first = firstProcesses.flat();
      const state = JSON.parse(readFileSync(join(ctx.home, ".openclaw/.notifyuser-state.json"), "utf8"));
      const retries = await run(ctx.identities, true);
      const remainingClaims = readdirSync(ctx.lockDir).filter((name) => name.endsWith(".claim"));
      return { ...ctx, first, remainingClaims, retries, state };
    }],
    then: ["stale recovery is bounded and all receipts survive for local-only reload", ({
      first, remainingClaims, retries, state,
    }) => {
      expect(first).toHaveLength(12);
      expect(first.every((result) => result.sent === true)).toBe(true);
      expect(Object.keys(state)).toHaveLength(12);
      expect(retries).toHaveLength(12);
      expect(retries.every((result) => result.sent === false && result.deduped === true)).toBe(true);
      expect(remainingClaims).toEqual([]);
    }],
    cleanup: async ({ home }) => rmSync(home, { recursive: true, force: true }),
  });

  unit("derives a stable bounded Discord nonce for explicit idempotency", {
    when: ["building two notification retries", () => {
      const first = notificationNonce("suggestions-comment-notify:skydive:SKY-10:7");
      const second = notificationNonce("suggestions-comment-notify:skydive:SKY-10:7");
      return { first, second, payload: discordMessagePayload("unanswered", first) };
    }],
    then: ["the retry uses one enforce_nonce identity", ({ first, second, payload }) => {
      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f]{25}$/u);
      expect(payload).toEqual({ content: "unanswered", nonce: first, enforce_nonce: true });
      expect(() => notificationNonce("unsafe key with spaces")).toThrow("safe identity");
    }],
  });

  unit("formats compact mobile notification", {
    when: ["formatting an error notification", () => formatUserNotification("dream failed", {
      level: "error",
      title: "Dream",
    })],
    then: ["title, level, and message are present", (result) => {
      expect(result).toContain("**Dream**");
      expect(result).toContain("(error)");
      expect(result).toContain("dream failed");
    }],
  });

  unit("uses explicit user id first", {
    when: ["resolving with explicit id", () => resolveNotifyUserId("123")],
    then: ["explicit id wins", (result) => expect(result).toBe("123")],
  });

  unit("falls back to OpenClaw discord allowFrom when env is unset", {
    given: ["temporary HOME with one allowed Discord user", () => {
      const oldHome = process.env.HOME;
      const oldNotify = process.env.AMUX_NOTIFY_USER_ID;
      const oldNotifyDiscord = process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      const home = mkdtempSync(join(tmpdir(), "amux-notify-home-"));
      const credDir = join(home, ".openclaw/credentials");
      mkdirSync(credDir, { recursive: true });
      writeFileSync(join(credDir, "discord-allowFrom.json"), JSON.stringify({
        version: 1,
        allowFrom: ["307938013604872192"],
      }));
      process.env.HOME = home;
      delete process.env.AMUX_NOTIFY_USER_ID;
      delete process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      return { home, oldHome, oldNotify, oldNotifyDiscord };
    }],
    when: ["resolving notify user id", () => resolveNotifyUserId()],
    then: ["the single allowed user is used", (result, ctx) => {
      expect(result).toBe("307938013604872192");
      process.env.HOME = ctx.oldHome;
      if (ctx.oldNotify === undefined) delete process.env.AMUX_NOTIFY_USER_ID;
      else process.env.AMUX_NOTIFY_USER_ID = ctx.oldNotify;
      if (ctx.oldNotifyDiscord === undefined) delete process.env.AMUX_NOTIFY_USER_DISCORD_ID;
      else process.env.AMUX_NOTIFY_USER_DISCORD_ID = ctx.oldNotifyDiscord;
      rmSync(ctx.home, { recursive: true, force: true });
    }],
  });
});

feature("Discord send helpers", () => {
  unit("uploads amux image payloads as binary multipart with their caption", {
    given: ["a local png and mocked Discord API", () => {
      const oldToken = process.env.DISCORD_TOKEN;
      const oldFetch = global.fetch;
      const root = mkdtempSync(join(tmpdir(), "amux-file-post-"));
      const imagePath = join(root, "proof.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      writeFileSync(imagePath, bytes);
      process.env.DISCORD_TOKEN = "test-token";
      const calls = [];
      global.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ id: "message-1" }) };
      };
      return { bytes, calls, imagePath, oldFetch, oldToken, root };
    }],
    when: ["posting through the helper used by amux image", async (ctx) => {
      await sendFileToChannelId("channel-1", ctx.imagePath, "visuellt bevis");
      return ctx;
    }],
    then: ["Discord receives one file part and the caption", async ({ bytes, calls, oldFetch, oldToken, root }) => {
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/channels/channel-1/messages");
      expect(calls[0].opts.method).toBe("POST");
      expect(calls[0].opts.headers.Authorization).toBe("Bot test-token");
      expect(calls[0].opts.body).toBeInstanceOf(FormData);
      expect(JSON.parse(calls[0].opts.body.get("payload_json"))).toEqual({ content: "visuellt bevis" });
      const uploaded = calls[0].opts.body.get("files[0]");
      expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(bytes);
      global.fetch = oldFetch;
      if (oldToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = oldToken;
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("splits long messages instead of truncating at 2000 characters", {
    given: ["mocked Discord token and fetch", () => {
      const oldToken = process.env.DISCORD_TOKEN;
      process.env.DISCORD_TOKEN = "test-token";
      const calls = [];
      const oldFetch = global.fetch;
      global.fetch = async (_url, opts) => {
        calls.push(JSON.parse(opts.body).content);
        return { ok: true, json: async () => ({ id: String(calls.length) }) };
      };
      return { calls, oldFetch, oldToken };
    }],
    when: ["sending a long message", async (ctx) => {
      await sendToChannelId("channel-1", "å".repeat(2500));
      return ctx;
    }],
    then: ["all content is sent across chunks", ({ calls, oldFetch, oldToken }) => {
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.join("")).toBe("å".repeat(2500));
      global.fetch = oldFetch;
      if (oldToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = oldToken;
    }],
  });
});
