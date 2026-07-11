import { unit, feature, expect } from "bdd-vitest";
import { appendFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parkPane,
  unparkPane,
  readParkState,
  shouldBlockSend,
  blockedSendMessage,
  PARK_MAX_AGE_MS,
} from "./pane-park.mjs";

const tmpPath = () =>
  join(tmpdir(), `amux-park-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
const cleanup = (p) => { try { unlinkSync(p); } catch {} };

feature("park/unpark ledger roundtrip", () => {
  unit("no events means not parked", {
    given: ["a fresh ledger path", () => ({ path: tmpPath() })],
    when: ["reading park state", ({ path }) => readParkState("api", 3, { path })],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("park is readable with since-timestamp and detail", {
    given: ["a parked pane", () => {
      const path = tmpPath();
      parkPane({ session: "api", pane: 3, detail: "gpt-5.6-sol xhigh → gpt-5.6-luna low", path });
      return { path };
    }],
    when: ["reading park state", ({ path }) => {
      const r = readParkState("api", 3, { path });
      return r;
    }],
    then: ["parked with detail", (r, { path }) => {
      cleanup(path);
      expect(r).not.toBeNull();
      expect(r.detail).toContain("luna");
      expect(Number.isFinite(r.sinceMs)).toBe(true);
    }],
  });

  unit("latest event wins: park then unpark is not parked", {
    given: ["park followed by unpark", () => {
      const path = tmpPath();
      parkPane({ session: "api", pane: 3, detail: "downgrade", path });
      unparkPane({ session: "api", pane: 3, detail: "model restored", path });
      return { path };
    }],
    when: ["reading park state", ({ path }) => readParkState("api", 3, { path })],
    then: ["null", (r, { path }) => {
      cleanup(path);
      expect(r).toBeNull();
    }],
  });

  unit("park on one pane does not park siblings", {
    given: ["api:3 parked", () => {
      const path = tmpPath();
      parkPane({ session: "api", pane: 3, detail: "downgrade", path });
      return { path };
    }],
    when: ["reading api:1 and lsrc:3", ({ path }) => ({
      other: readParkState("api", 1, { path }),
      otherSession: readParkState("lsrc", 3, { path }),
    })],
    then: ["both null", (r, { path }) => {
      cleanup(path);
      expect(r.other).toBeNull();
      expect(r.otherSession).toBeNull();
    }],
  });

  unit("a park older than PARK_MAX_AGE_MS expires (fail-open)", {
    given: ["a pane parked long ago", () => {
      const path = tmpPath();
      parkPane({ session: "api", pane: 3, detail: "downgrade", path });
      return { path, later: Date.now() + PARK_MAX_AGE_MS + 60_000 };
    }],
    when: ["reading with a clock past the window", ({ path, later }) =>
      readParkState("api", 3, { path, now: later })],
    then: ["null", (r, { path }) => {
      cleanup(path);
      expect(r).toBeNull();
    }],
  });

  unit("busy-ledger churn cannot push an active park outside the read window", {
    given: ["a park followed by more than the generic ledger's 256KB tail", () => {
      const path = tmpPath();
      parkPane({ session: "api", pane: 3, detail: "downgrade", path });
      const row = JSON.stringify({
        ts: new Date().toISOString(), event: "delivery", session: "other", pane: 0,
        detail: "x".repeat(400),
      }) + "\n";
      appendFileSync(path, row.repeat(800));
      return { path };
    }],
    when: ["reading park state", ({ path }) => readParkState("api", 3, { path })],
    then: ["the safety interlock remains visible", (r, { path }) => {
      cleanup(path);
      expect(r).not.toBeNull();
      expect(r.detail).toBe("downgrade");
    }],
  });
});

feature("shouldBlockSend guard decision", () => {
  const park = { sinceMs: 1_700_000_000_000, detail: "sol → luna" };

  unit("prompt to a parked pane is blocked", {
    given: ["a work brief", () => ({ text: "kör hela testsviten", park })],
    when: ["deciding", (args) => shouldBlockSend(args)],
    then: ["blocked", (r) => expect(r).toBe(true)],
  });

  unit("prompt to an unparked pane passes", {
    given: ["no park", () => ({ text: "kör hela testsviten", park: null })],
    when: ["deciding", (args) => shouldBlockSend(args)],
    then: ["passes", (r) => expect(r).toBe(false)],
  });

  unit("slash commands are administration and pass a parked pane", {
    given: ["the /model recovery action", () => ({ text: "/model gpt-5.6-sol", park })],
    when: ["deciding", (args) => shouldBlockSend(args)],
    then: ["passes", (r) => expect(r).toBe(false)],
  });

  unit("force overrides the park", {
    given: ["an explicit override", () => ({ text: "kör ändå", park, force: true })],
    when: ["deciding", (args) => shouldBlockSend(args)],
    then: ["passes", (r) => expect(r).toBe(false)],
  });

  unit("a path-like string is a prompt, not a slash command", {
    given: ["a message starting with a filesystem path", () => ({ text: "/home/x/notes.md läses fel", park })],
    when: ["deciding", (args) => shouldBlockSend(args)],
    then: ["blocked (paths are not commands)", (r) => expect(r).toBe(true)],
  });
});

feature("blockedSendMessage", () => {
  unit("names the pane, the downgrade and the override", {
    given: ["a parked pane 5 min ago", () => ({
      paneKey: "api:3",
      park: { sinceMs: Date.now() - 5 * 60_000, detail: "sol xhigh → luna low" },
    })],
    when: ["formatting", ({ paneKey, park }) => blockedSendMessage(paneKey, park)],
    then: ["contains pane, models, minutes and --force", (r) => {
      expect(r).toContain("api:3");
      expect(r).toContain("luna");
      expect(r).toMatch(/5 min/);
      expect(r).toContain("--force");
    }],
  });
});
