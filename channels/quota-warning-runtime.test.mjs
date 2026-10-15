import { EventEmitter } from "node:events";
import { feature, unit, expect } from "bdd-vitest";
import { createAmuxCommentDeliverer } from "../core/suggestions-comment-bridge.mjs";
import { createQuotaWarningActorDeliverer } from "./quota-warning-runtime.mjs";

feature("quota reserve panel delivery", () => {
  unit("reserve uses the durable CLI with provenance, stdin and a stable identity", {
    given: ["the ordinary CLI deliverer with a process boundary", () => {
      const calls = [];
      const deliver = createAmuxCommentDeliverer({ amuxBin: "/release/bin/agent-cli.mjs",
        spawnImpl: (command, args) => {
          const child = new EventEmitter();
          child.stdin = new EventEmitter();
          child.stdin.end = text => { calls.push({ command, args, text }); queueMicrotask(() => child.emit("close", 0)); };
          return child;
        } });
      return { calls, send: createQuotaWarningActorDeliverer({ deliver }) };
    }],
    when: ["reserve is handed to api:0", async (fx) => {
      await fx.send("api:0", "quota notice", { idempotencyKey: "weekly:window:reserve:actor:api:0" }); return fx.calls[0];
    }],
    then: ["the normal at-most-once queue handles it without a shell", ({ command, args, text }) => {
      expect(command).toBe(process.execPath);
      expect(args).toEqual(["/release/bin/agent-cli.mjs", "api", "-p", "0", "--idempotency-key",
        "weekly:window:reserve:actor:api:0", "--stdin", "--wait-ms", "0", "-q"]);
      expect(text).toBe("[quota-warning reserve]\nquota notice");
    }],
  });
});
