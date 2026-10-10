import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { recoverSubmittedTui } from "./submitted-tui-recovery.mjs";

const STALLED_JOB = "[from lsrc:1]\n\n/home/adelost/lsrc/.artifacts/cutkit-quality-2026-10-09/e283-share/e283-fore-efter-390.png\n";

feature("a submitted Claude prompt held by Pasting… is recovered in place", () => {
  // skyvw:0, 2026-10-09 22:09Z: recovery read the held paste as an idle empty composer, restarted the
  // pane and pasted the same text into the same clipboard wait, which then held the pane for hours.
  component("the lookup is ended, the pane is never restarted, and the draft gets one Enter", {
    given: ["a prompt submitted ten minutes ago whose paste still waits on Claude's clipboard lookup", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-submitted-paste-"));
      let clock = 600_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const created = queue.enqueue({ agentName: "skyvw", pane: 0, text: STALLED_JOB });
      const job = queue.update(created, {
        status: "submitted", submittedAt: 1_000, echoCursor: { kind: "claude-prompt-events-v1", positions: {} },
      });
      let composer = "pasting";
      const calls = { settle: 0, enter: 0, restart: 0 };
      const agent = {
        paneProcessState: async () => ({ running: true, dead: false, shell: false, command: "claude" }),
        promptTransportState: async () => ({ state: composer, busy: false, dialect: "claude" }),
        settleClaudePaste: async () => { calls.settle++; composer = "drafted"; return { ok: true, released: [21, 22] }; },
        restartPaneExact: async () => { calls.restart++; return { ok: true, dialect: "claude" }; },
        sendEnter: async () => { calls.enter++; },
      };
      return { rootDir, queue, job, agent, calls, now: () => clock, advance: () => { clock += 1_001; } };
    }],
    when: ["recovery visits the job twice", async (ctx) => {
      const pass = (job) => recoverSubmittedTui({
        job, agent: ctx.agent, queue: ctx.queue, now: ctx.now, onRecovered: () => {},
        exactEcho: async () => false, acknowledge: () => { throw new Error("no receipt exists"); },
      });
      const first = await pass(ctx.job);
      ctx.advance();
      const second = await pass(ctx.queue.read("skyvw", 0, ctx.job.id));
      return { first, second };
    }],
    then: ["one settle, one Enter on the landed draft, no restart and no second paste", ({ first, second }, ctx) => {
      try {
        expect(ctx.calls).toEqual({ settle: 1, enter: 1, restart: 0 });
        expect(first.lastReason).toMatch(/ended pids 21, 22/u);
        expect(second).toMatchObject({ status: "submitted", metadata: { submittedRecoveryKind: "exact-draft-enter" } });
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });
});
