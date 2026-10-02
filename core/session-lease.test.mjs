import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { regainSessionLease } from "./session-lease.mjs";

const twoBridges = () => {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-session-lease-"));
  return { rootDir, first: createDeliveryQueue({ rootDir }), second: createDeliveryQueue({ rootDir }) };
};

feature("a session lease can narrow to one fenced pane", () => {
  component("siblings are served while a pane waits on its engine", {
    given: ["lsrc:3 sent a compact and kept only its pane fence", () => {
      const ctx = twoBridges();
      ctx.compacting = ctx.first.acquireSessionLease("lsrc", 3);
      ctx.compacting.releaseSession();
      return ctx;
    }],
    when: ["other writers ask for the session", ({ second }) => {
      const sibling = second.acquireSessionLease("lsrc", 2);
      sibling?.release();
      const samePane = second.acquireSessionLease("lsrc", 3);
      const wholeSession = second.acquireSessionLease("lsrc");
      return { sibling, samePane, wholeSession };
    }],
    then: ["only the compacting pane and whole-session work wait", ({ sibling, samePane, wholeSession }, ctx) => {
      try {
        expect(sibling).toBeTruthy();
        expect(samePane).toBeNull();
        expect(wholeSession).toBeNull();
      } finally {
        ctx.compacting.release();
        rmSync(ctx.rootDir, { recursive: true, force: true });
      }
    }],
  });

  component("a fenced pane regains the session only once a sibling is done", {
    given: ["a sibling holds the session after lsrc:3 narrowed its lease", () => {
      const ctx = twoBridges();
      ctx.compacting = ctx.first.acquireSessionLease("lsrc", 3);
      ctx.compacting.releaseSession();
      ctx.sibling = ctx.second.acquireSessionLease("lsrc", 2);
      return ctx;
    }],
    when: ["lsrc:3 tries before and after the sibling releases", (ctx) => {
      const during = ctx.compacting.restoreSession();
      ctx.sibling.release();
      const after = ctx.compacting.restoreSession();
      const released = (ctx.compacting.release(), ctx.second.acquireSessionLease("lsrc"));
      released?.release();
      return { during, after, released };
    }],
    then: ["the session returns without ever having two writers", ({ during, after, released }, ctx) => {
      try {
        expect(during).toBe(false);
        expect(after).toBe(true);
        expect(released).toBeTruthy();
      } finally {
        rmSync(ctx.rootDir, { recursive: true, force: true });
      }
    }],
  });
});

feature("regaining a session lease is bounded", () => {
  unit("gives up after the timeout instead of writing without the session", {
    when: ["the session stays busy", async () => {
      let waited = 0;
      const regained = await regainSessionLease({ restoreSession: () => false },
        { timeoutMs: 1_000, pollMs: 250, sleep: async (ms) => { waited += ms; } });
      return { regained, waited };
    }],
    then: ["it reports failure after the bounded wait", ({ regained, waited }) => {
      expect(regained).toBe(false);
      expect(waited).toBe(1_000);
    }],
  });

  unit("a lease that never narrows needs no regain", {
    when: ["regaining a plain lease", () => regainSessionLease({ release() {} })],
    then: ["it is still the session writer", (regained) => expect(regained).toBe(true)],
  });
});
