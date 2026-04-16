import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRecorder } from "../core/recorder.mjs";

// --- Test helpers ---

function freshDir() {
  return mkdtempSync(join(tmpdir(), "agentmux-recorder-test-"));
}

function listJsons(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

/** Drop N pre-existing recordings with ascending mtimes (oldest first). */
function seedRecordings(dir, count) {
  for (let i = 0; i < count; i++) {
    const name = `old-${String(i).padStart(4, "0")}.json`;
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ i }));
    // Stagger mtimes by 1s so sort order is deterministic
    const mtime = 1_700_000_000 + i;
    utimesSync(path, mtime, mtime);
  }
}

// --- Basic save ---

feature("createRecorder: basic save", () => {
  unit("null dir returns a no-op recorder", {
    when: ["creating with dir=null", () => createRecorder({ dir: null })],
    then: ["enabled=false and save is a no-op", (r) => {
      expect(r.enabled).toBe(false);
      expect(() => r.save({ anything: true })).not.toThrow();
    }],
  });

  unit("save writes a JSON file named with timestamp + agent + pane", {
    given: ["a fresh dir", () => ({ dir: freshDir(), recorder: null })],
    when: ["saving one recording", (ctx) => {
      ctx.recorder = createRecorder({ dir: ctx.dir });
      ctx.recorder.save({ agent: "claw", pane: 1, items: [{ type: "text", content: "hi" }] });
    }],
    then: ["one .json file exists with agent+pane in the name", (_, { dir }) => {
      const files = listJsons(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/claw-p1\.json$/);
      rmSync(dir, { recursive: true, force: true });
    }],
  });

  unit("sanitizes weird agent names in the filename", {
    given: ["a fresh dir", () => ({ dir: freshDir() })],
    when: ["saving a recording with a spaced agent name", ({ dir }) => {
      createRecorder({ dir }).save({ agent: "claw / cdx", pane: 0 });
    }],
    then: ["non-[a-z0-9_-] chars become _", (_, { dir }) => {
      const files = listJsons(dir);
      expect(files[0]).toMatch(/claw___cdx-p0\.json$/);
      rmSync(dir, { recursive: true, force: true });
    }],
  });
});

// --- Rotation ---

feature("createRecorder: rotation (keep max N)", () => {
  unit("leaves files alone when count is under maxRecordings", {
    given: ["dir with 3 pre-existing files", () => {
      const dir = freshDir();
      seedRecordings(dir, 3);
      return { dir };
    }],
    when: ["saving one more with max=10", ({ dir }) => {
      createRecorder({ dir, maxRecordings: 10 }).save({ agent: "claw", pane: 0 });
    }],
    then: ["all 4 files remain", (_, { dir }) => {
      expect(listJsons(dir)).toHaveLength(4);
      rmSync(dir, { recursive: true, force: true });
    }],
  });

  unit("prunes oldest files when count exceeds maxRecordings", {
    given: ["dir with 5 pre-existing files", () => {
      const dir = freshDir();
      seedRecordings(dir, 5); // old-0000 (oldest) .. old-0004
      return { dir };
    }],
    when: ["saving 1 more with max=3", ({ dir }) => {
      // After save: 6 files total, need to keep 3 newest → delete 3 oldest
      createRecorder({ dir, maxRecordings: 3 }).save({ agent: "claw", pane: 0 });
    }],
    then: ["only 3 newest remain; oldest seeds deleted", (_, { dir }) => {
      const files = listJsons(dir);
      expect(files).toHaveLength(3);
      // old-0000, old-0001, old-0002 should be gone
      expect(files.filter((f) => f.startsWith("old-0000"))).toHaveLength(0);
      expect(files.filter((f) => f.startsWith("old-0001"))).toHaveLength(0);
      expect(files.filter((f) => f.startsWith("old-0002"))).toHaveLength(0);
      // Just-saved recording is in the kept set
      expect(files.filter((f) => f.includes("claw-p0"))).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    }],
  });

  unit("maxRecordings=0 disables rotation (unbounded growth)", {
    given: ["dir with 3 pre-existing files", () => {
      const dir = freshDir();
      seedRecordings(dir, 3);
      return { dir };
    }],
    when: ["saving 1 more with max=0", ({ dir }) => {
      createRecorder({ dir, maxRecordings: 0 }).save({ agent: "claw", pane: 0 });
    }],
    then: ["all 4 files remain, nothing pruned", (_, { dir }) => {
      expect(listJsons(dir)).toHaveLength(4);
      rmSync(dir, { recursive: true, force: true });
    }],
  });

  unit("default max keeps the most recent 500", {
    given: ["dir with 502 seeded files", () => {
      const dir = freshDir();
      seedRecordings(dir, 502);
      return { dir };
    }],
    when: ["saving 1 more with default max", ({ dir }) => {
      createRecorder({ dir }).save({ agent: "claw", pane: 0 });
    }],
    then: ["exactly 500 files kept (503 - 3 oldest)", (_, { dir }) => {
      const files = listJsons(dir);
      expect(files).toHaveLength(500);
      // The two oldest seeds are gone
      expect(files.filter((f) => f.startsWith("old-0000"))).toHaveLength(0);
      expect(files.filter((f) => f.startsWith("old-0001"))).toHaveLength(0);
      expect(files.filter((f) => f.startsWith("old-0002"))).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    }],
  });
});
