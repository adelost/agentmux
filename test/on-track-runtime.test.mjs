import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { vi } from "vitest";
import { createState } from "../core/state.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createOnTrackRuntime } from "../channels/on-track.mjs";
import { ON_TRACK_STATE } from "../core/on-track-monitor.mjs";
import { cmdOnTrack } from "../cli/on-track.mjs";

feature("normal on-track queue and CLI receipt seam", () => {
  component("an actual captured command and Git quote complete one queued review", {
    when: ["the actual runtime, command recorder and submit handler run on an isolated repository", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-on-track-runtime-"));
      const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
      git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
      const quote = "| 1 | Existing outcome | fixture:0 | Real done condition | closed | 1h |";
      writeFileSync(join(root, "TASKS.md"), `| # | Outcome | Owner | Done when | State | Estimate |\n|---|---|---|---|---|---|\n${quote}\n`);
      git("add", "TASKS.md"); git("commit", "-qm", "isolated fixture");
      const tip = git("rev-parse", "HEAD"), at = Date.now();
      const project = { id: "fixture", root, ledger: "TASKS.md", askAgents: ["fixture"], reviewer: "fixture:0", dispatcher: "fixture:1", livePaths: ["open"],
        probes: { live: [process.execPath, "-e", `console.log(JSON.stringify({live:[{path:'open',result:'PASS',at:'${new Date(at).toISOString()}'}]}))`] } };
      const state = createState(join(root, "state.json")), queue = createDeliveryQueue({ rootDir: join(root, "queue") });
      const projects = () => [project];
      const runtime = createOnTrackRuntime({ state, queue, projects, snapshot: () => ({ tip, asks: [] }) });
      await runtime.tick();
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const evidence = await cmdOnTrack(["capture", "fixture", "live"], { state, queue, projects });
        const cycle = state.get(ON_TRACK_STATE).projects.fixture.cycle;
        const fileEvidence = { kind: "file", path: "TASKS.md", sha: tip, line: 3, quote, at: new Date(at).toISOString() };
        const receipt = { project: "fixture", cycle: cycle.id, at: new Date().toISOString(),
          checks: ["C1", "C2", "C3", "C4", "C5"].map(id => ({ id, result: "PASS", evidence: [fileEvidence] })),
          asks: [], rows: [], live: [{ path: "open", result: "PASS", at: new Date(at).toISOString(), evidence }], deviations: [], outcomeChanges: [], resolved: [] };
        const file = join(root, "receipt.json"); writeFileSync(file, JSON.stringify(receipt));
        const result = await cmdOnTrack(["submit", "fixture", file], { state, projects, queue, actor: "fixture:0" });
        const reminder = queue.list("fixture", 0)[0];
        queue.update(reminder, { status: "acknowledged", acknowledgedAt: Date.now() });
        await runtime.tick();
        const captured = Object.values(state.get(ON_TRACK_STATE).commands)[0];
        return { result, captured, jobs: queue.list("fixture", 0), raw: JSON.parse(readFileSync(join(root, "state.json"), "utf8")) };
      } finally { output.mockRestore(); }
    }],
    then: ["one review is stored and the green receipt sends no extra status", r => {
      expect(r.result.errors).toEqual([]); expect(r.result.valid).toBe(true);
      expect(r.captured.exitCode).toBe(0); expect(r.jobs).toHaveLength(1);
      expect(r.raw[ON_TRACK_STATE].projects.fixture.cycle.review.valid).toBe(true);
      expect(r.raw[ON_TRACK_STATE].projects.fixture.cycle.deliveries.reminder.status).toBe("delivered");
    }],
  });
});

feature("on-track state writes during a delivery", () => {
  // defect: every transport step of a reminder rewrote the whole on-track state (236 MB, 8 MB/s on 27 Oct).
  component("transport steps between queued and acknowledged leave the state file alone", {
    when: ["a reminder passes through its transport steps", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-on-track-writes-"));
      const project = { id: "fixture", root, ledger: "TASKS.md", askAgents: ["fixture"], reviewer: "fixture:0", dispatcher: "fixture:1", livePaths: ["open"] };
      const state = createState(join(root, "state.json")), queue = createDeliveryQueue({ rootDir: join(root, "queue") });
      const runtime = createOnTrackRuntime({ state, queue, projects: () => [project], snapshot: () => ({ tip: "abc", asks: [] }) });
      await runtime.tick();
      const reminder = queue.list("fixture", 0)[0], updates = vi.spyOn(state, "updateKey");
      for (const status of ["delivering", "submitted"]) { queue.update(queue.read("fixture", 0, reminder.id), { status }); await runtime.tick(); }
      const duringTransport = updates.mock.calls.length;
      queue.update(queue.read("fixture", 0, reminder.id), { status: "acknowledged", acknowledgedAt: Date.now() });
      await runtime.tick();
      return { duringTransport, after: updates.mock.calls.length, delivered: state.get(ON_TRACK_STATE).projects.fixture.cycle.deliveries.reminder.status };
    }],
    then: ["only the final acknowledgement is written", r => {
      expect(r.duringTransport).toBe(0);
      expect(r.after).toBe(1);
      expect(r.delivered).toBe("delivered");
    }],
  });
});
