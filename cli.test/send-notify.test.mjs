import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatUserNotification,
  resolveNotifyUserId,
} from "../cli/send-notify.mjs";

feature("notifyuser helpers", () => {
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
