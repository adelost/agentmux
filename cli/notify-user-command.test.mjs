import { feature, unit, expect } from "bdd-vitest";
import { cmdNotifyUser } from "./notify-user-command.mjs";

const harness = () => {
  const sent = [], lines = [];
  return { sent, lines, deps: {
    send: async (text, options) => { sent.push({ text, options }); return { target: "dm" }; },
    render: async (text) => `rendered ${text}`,
    output: (line) => lines.push(line),
    fail: (message) => { throw new Error(message); },
  } };
};

feature("amux notifyuser", () => {
  unit("--help and -h print usage and never send (2026-10-10 a DM said \"--help\")", {
    given: ["a send that records", harness],
    when: ["asking for help both ways", async (ctx) => {
      await cmdNotifyUser(["--help"], ctx.deps);
      await cmdNotifyUser(["-h"], ctx.deps);
      return ctx;
    }],
    then: ["nothing is sent and usage is shown twice", (ctx) => {
      expect(ctx.sent).toEqual([]);
      expect(ctx.lines.filter((line) => line.startsWith("Usage: amux notifyuser"))).toHaveLength(2);
    }],
  });

  unit("a message is still sent with its level", {
    given: ["a send that records", harness],
    when: ["notifying", async (ctx) => { await cmdNotifyUser(["hej", "där", "--level", "warn"], ctx.deps); return ctx; }],
    then: ["one send with the joined text", (ctx) => {
      expect(ctx.sent).toEqual([{ text: "hej där", options: expect.objectContaining({ level: "warn" }) }]);
      expect(ctx.lines).toEqual(["notifyuser sent → dm"]);
    }],
  });
});
