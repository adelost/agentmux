// The disk cleanup removes regenerable caches and finished checkouts, and moves
// old artifacts to Q:. These tests cover the deletion and move boundaries.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import { moveArtifacts, planArtifactOverflow } from "./artifact-overflow.mjs";
import { dependencySymlinkConsumers, inspectDependencyCacheEntry, planDependencyCacheRetirement } from "./disk-cache-retention.mjs";
import { uvPruneVerdict } from "./disk-cleanup.mjs";
import { cleanupDue, pollDiskGuardOnce } from "./disk-guard.mjs";

const DAY = 86400000;
const hex = (text) => createHash("sha256").update(text).digest("hex");

/** WHAT: Builds one store entry the inspector accepts, with an npm-recorded package list. WHY: Lets each test vary only the package that matters. */
function dependencyEntry(root, packages, installed) {
  const input = { packageHash: hex("p"), lockHash: hex("l"), repoRelativeRoot: "app" };
  const key = hex(JSON.stringify(input).replaceAll(" ", "")).slice(0, 32);
  const entry = join(root, "store", "0123456789abcdef", "node", key);
  mkdirSync(join(entry, "node_modules"), { recursive: true });
  writeFileSync(join(entry, "manifest.json"), JSON.stringify({ version: 1, input: { ...input, key } }));
  writeFileSync(join(entry, "node_modules", ".package-lock.json"), JSON.stringify({ packages }));
  for (const name of installed) { mkdirSync(join(entry, "node_modules", name), { recursive: true }); writeFileSync(join(entry, "node_modules", name, "index.js"), "x"); }
  return entry;
}

const idle = (paths) => ({ holders: Object.fromEntries(paths.map((path) => [path, []])), errors: [] });

feature("disk cleanup removes only what regenerates and moves artifacts without deleting them", () => {
  // lsrc:0 2026-10-22: the guard held 132 entries as incomplete because the lock lists @img/sharp-darwin-arm64.
  component("a dependency entry missing only npm's other-platform optionals is inspectable; a real missing package is not", {
    given: ["one entry without its ideallyInert fsevents and one without a required esbuild", () => {
      const root = mkdtempSync(join(tmpdir(), "deps-"));
      return { root, entry: dependencyEntry(root, { "node_modules/vite": {}, "node_modules/fsevents": { optional: true, ideallyInert: true } }, ["vite"]),
        broken: dependencyEntry(join(root, "other"), { "node_modules/vite": {}, "node_modules/esbuild": {} }, ["vite"]) };
    }],
    when: ["inspecting both", ({ entry, broken }) => ({ inspected: inspectDependencyCacheEntry(entry), missing: inspectDependencyCacheEntry(broken) })],
    then: ["only the real missing package blocks retirement", ({ inspected, missing }) => {
      expect(inspected.reason).toBeUndefined();
      expect(inspected.bytes).toBeGreaterThan(0);
      expect(missing.reason).toMatch(/missing or linked installed dependency|No such file/u);
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });

  // 2026-10-22: every one of 239 entries had a file read within the hour, from scans rather than checkouts,
  // so access time kept every entry "used" and none ever aged out.
  component("a read alone does not keep a dependency entry unused for seven days", {
    given: ["an entry whose files were read later than the retention period but not linked or changed", () => {
      const root = mkdtempSync(join(tmpdir(), "deps-"));
      const entry = dependencyEntry(root, { "node_modules/vite": {} }, ["vite"]);
      const read = new Date(Date.now() + 8 * DAY), written = new Date(Date.now() - 30 * DAY);
      for (const path of ["node_modules/vite/index.js", "node_modules/.package-lock.json", "manifest.json"]) utimesSync(join(entry, path), read, written);
      return { root, entry };
    }],
    when: ["planning eight days later", ({ root }) => planDependencyCacheRetirement({ repositoryRoots: [], storeRoots: [join(root, "store")],
      nowMs: Date.now() + 8 * DAY, references: idle, consumers: () => ({ linked: new Set(), errors: [] }) })],
    then: ["the entry is a candidate", (plan, { entry }) => {
      expect(plan.skipped).toEqual([]);
      expect(plan.candidates.map(({ path }) => path)).toEqual([entry]);
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });

  component("an unused dependency entry retires unless a checkout's node_modules symlinks into it", {
    given: ["an old entry and a checkout", () => {
      const root = mkdtempSync(join(tmpdir(), "deps-"));
      const entry = dependencyEntry(root, { "node_modules/vite": {} }, ["vite"]);
      mkdirSync(join(root, "checkout", "node_modules"), { recursive: true });
      return { root, entry };
    }],
    when: ["planning before and after the checkout links the entry", ({ root, entry }) => {
      const plan = () => planDependencyCacheRetirement({ repositoryRoots: [], storeRoots: [join(root, "store")], nowMs: Date.now() + 30 * DAY,
        references: idle, consumers: (entries) => dependencySymlinkConsumers(entries, { searchRoots: [join(root, "checkout")] }) });
      const before = plan();
      symlinkSync(join(entry, "node_modules", "vite"), join(root, "checkout", "node_modules", "vite"));
      return { before, after: plan() };
    }],
    then: ["the linked entry is kept with its reason", ({ before, after }, { entry }) => {
      expect(before.candidates.map(({ path }) => path)).toEqual([entry]);
      expect(before.candidates[0].freeableBytes).toBeGreaterThan(0);
      expect(after.candidates).toEqual([]);
      expect(after.skipped.find(({ path }) => path === entry).reasons).toContain("symlinked by a checkout's node_modules");
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });

  // lsrc:0 2026-10-22: a forced prune removed an archive that 16 running voice-mode processes still mapped.
  unit("uv's cache is pruned only when no process holds a file in it and nothing installs", {
    then: ["a holder or an install keeps the cache; neither lets the prune run", () => {
      const holders = (pids) => () => ({ holders: { "/c/uv": pids }, errors: [] });
      const verdict = (ps, references) => uvPruneVerdict({ ps, cacheDir: "/c/uv", references, exists: true }).mode;
      expect(verdict("python -m voice_mode", holders([41, 42]))).toBe("kept");
      expect(verdict("uv sync --locked", holders([]))).toBe("kept");
      expect(verdict("node server.mjs", () => ({ holders: {}, errors: [{ error: "unreadable" }] }))).toBe("kept");
      expect(verdict("node server.mjs", holders([]))).toBe("would prune");
    }],
  });

  component("an artifact folder modified within 14 days or holding a browser profile stays; a recent ctime alone does not hold it", {
    given: ["a folder with 20-day-old mtimes, a folder with one new file, and a test browser profile", () => {
      const root = mkdtempSync(join(tmpdir(), "artifacts-")), artifacts = join(root, ".artifacts");
      for (const name of ["old", "new"]) { mkdirSync(join(artifacts, name, "deep"), { recursive: true }); writeFileSync(join(artifacts, name, "deep", "frame.png"), "pixels"); }
      mkdirSync(join(artifacts, "run", "chrome-profile", "Default"), { recursive: true }); writeFileSync(join(artifacts, "run", "chrome-profile", "Default", "Cookies"), "c");
      const past = new Date(Date.now() - 20 * DAY);
      for (const path of ["old/deep/frame.png", "old/deep", "old", "new/deep", "new", "run/chrome-profile/Default/Cookies", "run/chrome-profile/Default", "run/chrome-profile", "run"]) {
        utimesSync(join(artifacts, path), past, past);
      }
      return { root, artifacts };
    }],
    when: ["planning the move", ({ root, artifacts }) => planArtifactOverflow({ root: artifacts, overflowRoot: root, references: idle, freeBytes: () => 1e12 })],
    then: ["only the folder with old content is planned", (plan) => {
      expect(plan.candidates.map(({ path }) => path.split("/").at(-1))).toEqual(["old"]);
      expect(Object.fromEntries(plan.skipped.map(({ path, reasons }) => [path.split("/").at(-1), reasons])))
        .toEqual({ new: ["modified within 14 days"], run: ["holds a browser profile"] });
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });

  component("a planned artifact folder moves with rsync, keeps every file and records how to move it back", {
    given: ["one settled artifact folder and an empty Q:", () => {
      const root = mkdtempSync(join(tmpdir(), "artifacts-")), artifacts = join(root, ".artifacts"), q = join(root, "q");
      mkdirSync(join(artifacts, "old", "deep"), { recursive: true }); writeFileSync(join(artifacts, "old", "deep", "frame.png"), "pixels");
      mkdirSync(q);
      return { root, artifacts, q };
    }],
    when: ["moving a plan that admits it", ({ artifacts, q }) => {
      const settled = (paths) => Object.fromEntries(paths.map((path) => [path, { bytes: 6, files: 1, newestModifiedMs: Date.now() - 20 * DAY }]));
      const plan = planArtifactOverflow({ root: artifacts, overflowRoot: q, references: idle, freeBytes: () => 1e12, measure: settled });
      return { plan, moved: moveArtifacts(plan, { sampleDisk: () => ({ availableBytes: 0 }), references: idle, measure: settled }) };
    }],
    then: ["the file is on Q: under its absolute path, gone from /, and listed in MANIFEST.md", ({ plan, moved }, { artifacts }) => {
      expect(moved.map(({ mode }) => mode)).toEqual(["moved"]);
      expect(readFileSync(join(plan.destination, artifacts, "old", "deep", "frame.png"), "utf8")).toBe("pixels");
      expect(existsSync(join(artifacts, "old"))).toBe(false);
      const manifest = readFileSync(join(plan.destination, "MANIFEST.md"), "utf8");
      expect(manifest).toContain(`| ${join(artifacts, "old")} | 6 | 1 |`);
      expect(manifest).toContain("rsync -rlt --remove-source-files");
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });

  unit("the guard starts the cleanup once a night and every six hours at 80 % used, and alarms once per high-use episode", {
    then: ["nightly and high-use starts are spaced, and one alarm covers the episode", async () => {
      const at = (hour, minutes = 0) => new Date(2026, 9, 22, hour, minutes).getTime();
      const used = (percent) => ({ usedBytes: percent * 20e9, availableBytes: (100 - percent) * 20e9 });
      expect(cleanupDue({ sample: used(50), previous: null, nowMs: at(2) })).toBe(null);
      expect(cleanupDue({ sample: used(50), previous: null, nowMs: at(3) })).toBe("nightly");
      expect(cleanupDue({ sample: used(50), previous: { cleanup: { nightlyDate: "2026-10-22" } }, nowMs: at(4) })).toBe(null);
      expect(cleanupDue({ sample: used(80), previous: { cleanup: { nightlyDate: "2026-10-22", startedAt: new Date(at(3)).toISOString() } }, nowMs: at(8) })).toBe(null);
      expect(cleanupDue({ sample: used(80), previous: { cleanup: { nightlyDate: "2026-10-22", startedAt: new Date(at(3)).toISOString() } }, nowMs: at(9) })).toBe("high-use");
      let state = null, starts = 0; const alerts = [];
      for (const [hour, percent] of [[1, 79], [2, 85], [5, 90], [9, 90], [10, 70], [11, 82]]) {
        await pollDiskGuardOnce({ readState: () => state, writeState: (next) => { state = next; }, now: () => at(hour),
          sample: () => used(percent), startCleanup: async () => { starts++; return { started: true }; },
          notify: async (text) => { alerts.push(text); return { sent: true }; } });
      }
      expect(alerts).toEqual(["Disk guard: / is 85 % used, 300.0 GB free. Starting the cleanup.",
        "Disk guard: / is 82 % used, 360.0 GB free. Starting the cleanup."]);
      expect(starts).toBe(3);
    }],
  });
});
