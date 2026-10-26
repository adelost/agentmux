import { expect, feature, unit } from "bdd-vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOwnMarker } from "./runtime-markers.mjs";

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
