import { expect, feature, unit } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPidFile, clearDeadMarker, clearOwnMarker } from "./runtime-markers.mjs";

function markerFile(content) {
  const root = mkdtempSync(join(tmpdir(), "amux-marker-"));
  const path = join(root, "agentmux.pid");
  if (content !== null) writeFileSync(path, content);
  return { root, path };
}

feature("a stopping bridge's runtime markers (row 102)", () => {
  unit("leaves the marker of the bridge that stays", {
    given: ["a duplicate bridge 3968 stopping while the marker names 39295", () => markerFile("39295")],
    when: ["3968 clears its markers", ({ path, root }) => { clearOwnMarker(path, 3968); return { path, root }; }],
    then: ["the file is still there", ({ path, root }) => {
      expect(existsSync(path)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("removes the marker that names the stopping bridge", {
    given: ["a marker naming 3968 with a trailing newline", () => markerFile("3968\n")],
    when: ["3968 clears its markers", ({ path, root }) => { clearOwnMarker(path, 3968); return { path, root }; }],
    then: ["the file is gone", ({ path, root }) => {
      expect(existsSync(path)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("does nothing when there is no marker", {
    given: ["no marker file", () => markerFile(null)],
    when: ["a bridge clears its markers", ({ path, root }) => ({ path, root, result: clearOwnMarker(path, 3968) })],
    then: ["nothing throws and nothing exists", ({ path, root, result }) => {
      expect(result).toBeUndefined();
      expect(existsSync(path)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }],
  });
});

feature("two bridges claiming one pidfile (row 103)", () => {
  unit("the second claimer finds the live holder and refuses", {
    given: ["bridge 111 already holds the pidfile and runs", () => {
      const file = markerFile(null);
      return { ...file, first: claimPidFile(file.path, 111, { alive: () => true }) };
    }],
    when: ["bridge 222 claims the same file", ({ path, root, first }) => ({ root, path, first, second: claimPidFile(path, 222, { alive: pid => pid === 111 }) })],
    then: ["exactly one claim holds and the file still names 111", ({ path, root, first, second }) => {
      expect(first).toEqual({ claimed: true, holder: 111 });
      expect(second).toEqual({ claimed: false, holder: 111 });
      expect(readFileSync(path, "utf-8")).toBe("111");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("takes over a pidfile whose holder is gone", {
    given: ["a pidfile naming a dead bridge", () => markerFile("1827397")],
    when: ["bridge 222 claims it", ({ path, root }) => ({ root, path, claim: claimPidFile(path, 222, { alive: () => false }) })],
    then: ["the claim succeeds and the file names 222", ({ path, root, claim }) => {
      expect(claim.claimed).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("222");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("treats an unreadable pidfile as a dead holder", {
    given: ["a pidfile with no pid in it", () => markerFile("not a pid")],
    when: ["bridge 222 claims it", ({ path, root }) => ({ root, path, claim: claimPidFile(path, 222, { alive: () => true }) })],
    then: ["the claim succeeds", ({ path, root, claim }) => {
      expect(claim.claimed).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("222");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("a launch cleaning up leaves the marker of a bridge that runs", {
    given: ["a marker naming a running bridge", () => markerFile("4242")],
    when: ["the launch clears dead markers", ({ path, root }) => ({ root, path, cleared: clearDeadMarker(path, pid => pid === 4242) })],
    then: ["nothing is removed", ({ path, root, cleared }) => {
      expect(cleared).toBe(false);
      expect(existsSync(path)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("a launch cleaning up removes the marker of a bridge that is gone", {
    given: ["a marker naming a dead bridge", () => markerFile("4242")],
    when: ["the launch clears dead markers", ({ path, root }) => ({ root, path, cleared: clearDeadMarker(path, () => false) })],
    then: ["the marker is removed", ({ path, root, cleared }) => {
      expect(cleared).toBe(true);
      expect(existsSync(path)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }],
  });
});
