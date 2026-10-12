import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

feature("human messages do not starve behind an unverified Codex submit", () => {
  for (const kind of ["human-ten-minutes", "human-nine-minutes", "agent-ten-minutes"]) {
    component(kind, {
      given: ["a real spool, an ambiguous submit with no closed turn and one follower", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-human-backlog-")), file = join(root, "rollout.jsonl");
        writeFileSync(file, "");
        const submittedAt = 1000, now = submittedAt + (kind === "human-nine-minutes" ? 9 : 10) * 60_000;
        const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now, recordAsk: () => {} });
        const head = queue.enqueue({ agentName: "fixture", pane: 4, text: "unknown first input", createdAt: submittedAt });
        queue.update(head, { status: "submitted", attempts: 1, submittedAt, nextAttemptAt: 0,
          echoCursor: { kind: "codex-prompt-events-v1", positions: { [file]: 0 } } });
        const follower = queue.enqueue({ agentName: "fixture", pane: 4, text: "What happened?",
          source: kind.startsWith("agent") ? "cli" : "discord", createdAt: submittedAt + 1 });
        const echoed = new Set(), sends = [];
        const agent = { waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
          capturePromptEchoCursor: async () => ({ kind: "codex-prompt-events-v1", positions: { [file]: 0 } }),
          promptTransportState: async () => ({ dialect: "codex", busy: true, state: "empty-busy" }),
          dismissBlockingPrompt: async () => null, capturePane: async () => "› ",
          sendOnly: async (_name, text, _pane, options) => {
            sends.push(text); await options.onSubmitting?.(); await options.onSubmitted?.();
            echoed.add(text); return { submitted: true };
          } };
        return { root, head, follower, queue, sends, broker: createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {} }) };
      }],
      when: ["the normal broker drains twice without resending the ambiguous input", async fx => {
        await fx.broker.kickTarget("fixture", 4); await fx.broker.kickTarget("fixture", 4);
        return fx;
      }],
      then: ["only a ten-minute human backlog releases the lane, preserving attempt one as unverified", fx => {
        if (kind === "human-ten-minutes") {
          expect(fx.queue.read("fixture", 4, fx.head.id)).toMatchObject({ status: "delivered_unverified", attempts: 1, acknowledgedAt: null });
          expect(fx.queue.read("fixture", 4, fx.follower.id)).toMatchObject({ status: "acknowledged", attempts: 1 });
          expect(fx.sends).toEqual(["What happened?"]);
        } else {
          expect(fx.queue.read("fixture", 4, fx.head.id).status).toBe("submitted");
          expect(fx.sends).toEqual([]);
        }
      }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
    });
  }
});
