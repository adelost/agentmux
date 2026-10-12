import { feature, component, expect } from "bdd-vitest";
import { fenceCodexCapacityJobs } from "./codex-capacity-delivery.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

feature("capacity continuation is rechecked immediately before delivery", () => {
  for (const kind of ["new-input", "working", "dialog", "submitted"]) {
    component(`${kind} cannot receive a new automatic submit`, {
      given: ["an isolated scheduled continuation", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-capacity-fence-")), file = join(root, "journal.jsonl");
        const at = "2026-10-12T07:10:03.473Z";
        writeFileSync(file, kind === "new-input" ? JSON.stringify({ timestamp: "2026-10-12T07:12:00.000Z", type: "event_msg",
          payload: { type: "user_message", message: "kör" } }) + "\n" : "");
        const job = { id: "j1", source: "codex-capacity-recovery", status: kind === "submitted" ? "submitted" : "pending",
          attempts: kind === "submitted" ? 1 : 0, text: "continue", metadata: { capacityRefusedAt: at, capacitySessionFile: file } };
        const cancelled = [];
        const queue = { list: () => [job], read: () => job, update: (_, patch) => Object.assign(job, patch),
          requestCancellation: id => cancelled.push(id) };
        return { root, job, cancelled, queue };
      }],
      when: ["running the broker's pre-submit check", async fx => {
        await fenceCodexCapacityJobs({ agentName: "lsrc", pane: 5, queue: fx.queue, now: () => 1000, log: () => {},
          terminalizeNotSent: async job => { job.status = "cancelled"; },
          agent: { promptTransportState: async () => ({ dialect: "codex", state: "empty-idle", busy: kind === "working" }),
            captureScreen: async () => kind === "dialog" ? "Resume paused goal?\n› 1. Resume goal\n2. Leave paused\nPress enter to confirm or esc to go back" : "› " } });
        return fx;
      }],
      then: ["superseded input cancels, busy/menu waits, submitted evidence is untouched", fx => {
        if (kind === "new-input") expect(fx.job.status).toBe("cancelled");
        else if (kind === "submitted") { expect(fx.job.status).toBe("submitted"); expect(fx.cancelled).toEqual([]); }
        else expect(fx.job.nextAttemptAt).toBe(16000);
      }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
    });
  }
});
