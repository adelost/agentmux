import { expect, feature, unit } from "bdd-vitest";
import {
  fleetStopRecoveryEvent,
  hasResidentCodingProcess,
  stopRecoveryCandidate,
} from "./fleet-stop-recovery.mjs";

const NOW = Date.parse("2026-07-22T07:00:00Z");

feature("deliberate fleet-stop recovery evidence", () => {
  unit("a recent unfinished ask is preserved even when the composer looks idle", {
    given: ["one partial turn", () => stopRecoveryCandidate({
      agent: "skydive",
      pane: 1,
      paneStatus: "idle",
      residentCommand: "claude",
      nowMs: NOW,
      turns: [{
        timestamp: "2026-07-22T06:41:00Z",
        userPrompt: "task notification",
        items: [],
        isComplete: false,
      }],
    })],
    when: ["classifying before stop", (candidate) => candidate],
    then: ["the exact pane and ask timestamp become recovery evidence", (candidate) => {
      expect(candidate).toEqual({
        agent: "skydive",
        pane: 1,
        interruptedAtMs: Date.parse("2026-07-22T06:41:00Z"),
        evidence: "ask-open",
      });
    }],
  });

  unit("completed and old idle panes stay out of the recovery set", {
    then: ["neither shape is selected", () => {
      expect(stopRecoveryCandidate({
        agent: "ai", pane: 0, paneStatus: "idle", nowMs: NOW,
        residentCommand: "claude",
        turns: [{ timestamp: "2026-07-22T06:50:00Z", userPrompt: "done", items: [{ content: "Klart." }], isComplete: true }],
      })).toBeNull();
      expect(stopRecoveryCandidate({
        agent: "ai", pane: 7, paneStatus: "idle", nowMs: NOW,
        residentCommand: "kimi-code",
        turns: [{ timestamp: "2026-07-21T12:00:00Z", userPrompt: "old", items: [], isComplete: false }],
      })).toBeNull();
    }],
  });

  unit("a quota-limited pane is preserved even after its reply completed", {
    then: ["the live status is the evidence", () => {
      expect(stopRecoveryCandidate({
        agent: "skybar", pane: 1, paneStatus: "limited", nowMs: NOW, turns: [],
        residentCommand: "claude",
      })).toMatchObject({ agent: "skybar", pane: 1, evidence: "pane-limited" });
    }],
  });

  unit("a sleeping shell cannot inherit stale working truth", {
    then: ["only resident non-shell processes are eligible", () => {
      expect(hasResidentCodingProcess("bash")).toBe(false);
      expect(hasResidentCodingProcess("zsh")).toBe(false);
      expect(hasResidentCodingProcess("node")).toBe(true);
      expect(stopRecoveryCandidate({
        agent: "skybar",
        pane: 5,
        paneStatus: "working",
        residentCommand: "bash",
        turns: [],
        nowMs: NOW,
      })).toBeNull();
    }],
  });

  unit("the whole candidate batch is one append-only row", {
    then: ["identity and candidates are preserved", () => {
      const event = fleetStopRecoveryEvent([
        { agent: "skyvw", pane: 0, interruptedAtMs: 42, evidence: "ask-partial" },
        { agent: "skydive", pane: 1, interruptedAtMs: 43, evidence: "pane-working" },
      ], { stopId: "stop-1", now: new Date(NOW) });
      expect(event.event).toBe("fleet_stop_recovery");
      expect(event.stopId).toBe("stop-1");
      expect(event.panes).toHaveLength(2);
    }],
  });
});
