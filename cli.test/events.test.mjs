import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { eventCategory, buildActions, createEventLogger } from "../cli/events.mjs";

feature("eventCategory", () => {
  unit("classifies DONE as done", {
    given: ["DONE event", () => "DONE"],
    when: ["classifying", eventCategory],
    then: ["done", (c) => expect(c).toBe("done")],
  });

  unit("classifies STUCK as problem", {
    given: ["STUCK event", () => "STUCK"],
    when: ["classifying", eventCategory],
    then: ["problem", (c) => expect(c).toBe("problem")],
  });

  unit("classifies PROGRESS as compact", {
    given: ["PROGRESS event", () => "PROGRESS"],
    when: ["classifying", eventCategory],
    then: ["compact", (c) => expect(c).toBe("compact")],
  });
});

feature("buildActions", () => {
  unit("MENU suggests select command", {
    given: ["MENU event", () => ({ name: "ai", pane: 1, event: "MENU" })],
    when: ["building", ({ name, pane, event }) => buildActions(name, pane, event)],
    then: ["contains select hint", (actions) => {
      expect(actions.some((a) => a.includes("select"))).toBe(true);
    }],
  });

  unit("STUCK suggests esc and log", {
    given: ["STUCK event", () => ({ name: "ai", pane: 0, event: "STUCK" })],
    when: ["building", ({ name, pane, event }) => buildActions(name, pane, event)],
    then: ["contains esc and log hints", (actions) => {
      expect(actions.some((a) => a.includes("esc"))).toBe(true);
      expect(actions.some((a) => a.includes("log"))).toBe(true);
    }],
  });
});

feature("createEventLogger", () => {
  unit("writes to log file", {
    given: ["a temp log file", () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmux-events-test-"));
      return { logFile: join(dir, "events.log"), dir };
    }],
    when: ["logging an event", ({ logFile }) => {
      const log = createEventLogger({ logFile });
      log("✅", "ai", 0, "DONE", "finished task");
      return logFile;
    }],
    then: ["log file contains event", (logFile, { dir }) => {
      const content = readFileSync(logFile, "utf-8");
      expect(content).toContain("DONE");
      expect(content).toContain("ai:0");
      expect(content).toContain("finished task");
      rmSync(dir, { recursive: true, force: true });
    }],
  });
});
