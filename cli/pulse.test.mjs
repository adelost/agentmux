// Guards pulse-5 (docs/DESIGN-pulse.md): `amux pulse io` shows how the bridge reached tmux, per verb, pane and asker,
// with the transport state, so the cost of watching panes is readable without a CPU profile.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { feature, unit, expect } from "bdd-vitest";
import { cmdPulse } from "./pulse.mjs";
import { createIoCounters, formatIoSnapshot, saveIoSnapshot } from "../core/pulse/io-counters.mjs";
import { createControlTransport } from "../core/pulse/control-transport.mjs";

feature("amux pulse io", () => {
  unit("shows counts per verb and pane", {
    given: ["a counter file with control questions, process starts and one disagreement", () => {
      const dir = mkdtempSync(join(tmpdir(), "pulse-io-"));
      const counters = createIoCounters({ now: () => Date.parse("2026-10-28T09:00:00Z") });
      counters.setTransport({ mode: "control", state: "ready", reason: null });
      for (let i = 0; i < 3; i++) counters.record({ path: "control", verb: "display-message", target: "claw:1" });
      counters.record({ path: "process", verb: null, target: null });
      counters.record({ path: "degraded", verb: "capture-pane", target: "skyvw:4" });
      counters.disagree({ verb: "display-message", target: "claw:1", process: 'ok "0\\n"', control: 'ok "1\\n"' });
      saveIoSnapshot(join(dir, "pulse-io.json"), counters.snapshot());
      return dir;
    }],
    when: ["the command prints it", (dir) => {
      const lines = [];
      cmdPulse(["io"], { path: join(dir, "pulse-io.json"), out: (text) => lines.push(text) });
      return lines.join("\n");
    }],
    then: ["the totals, the verbs, the panes and the disagreement are all there", (text) => {
      expect(text).toMatch(/transport control · client ready/u);
      expect(text).toMatch(/tmux questions over the client 3 · process starts 2 \(degraded 1, client 0\) · shadow checks 0 · disagreements 1/u);
      expect(text).toMatch(/display-message\s+3\s+0\s+0\s+0/u);
      expect(text).toMatch(/skyvw:4\s+0\s+0/u);
      expect(text).toMatch(/disagreement display-message claw:1: exec=ok "0\\n" control=ok "1\\n"/u);
    }],
    cleanup: (dir) => rmSync(dir, { recursive: true, force: true }),
  });

  unit("says when the bridge has written no counts yet", {
    given: ["a path with no counter file", () => mkdtempSync(join(tmpdir(), "pulse-io-"))],
    when: ["the command prints it", (dir) => {
      const lines = [];
      cmdPulse(["io"], { path: join(dir, "pulse-io.json"), out: (text) => lines.push(text) });
      return lines.join("\n");
    }],
    then: ["it says so instead of showing zeros", (text) => expect(text).toMatch(/no counts yet/u)],
    cleanup: (dir) => rmSync(dir, { recursive: true, force: true }),
  });

  unit("names who asked each question", {
    given: ["a transport whose questions come from one watcher function", () => {
      const counters = createIoCounters();
      const transport = createControlTransport({ socket: "/tmp/pulse-none.sock", mode: "exec", counters,
        processExec: async () => ({ stdout: "%1\n", stderr: "" }) });
      return { counters, transport };
    }],
    when: ["the watcher asks three times and the report is printed", async ({ counters, transport }) => {
      async function watchPanes() { return transport.exec("tmux -S '/tmp/pulse-none.sock' display-message -p -t 'a:.0' '#{pane_id}'"); }
      for (let i = 0; i < 3; i++) await watchPanes();
      transport.stop();
      return formatIoSnapshot(counters.snapshot());
    }],
    then: ["the report names the watcher with its three questions", (text) => {
      expect(text).toMatch(/\s3 {2}watchPanes cli\/pulse\.test\.mjs/u);
    }],
  });
});
