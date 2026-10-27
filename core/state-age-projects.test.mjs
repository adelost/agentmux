import { expect, feature, integration } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStateAgeProjects } from "./state-age-projects.mjs";
import { inferAskOrigin, isHumanAsk } from "./ask-origin.mjs";
import { stateAgeMessage } from "./state-age-guard.mjs";

feature("state-age reads board sources without guessing dispatcher identities", () => {
  integration("unmapped board ledgers remain visible and disabled reviews do not disable age routing", {
    given: ["one routed board ledger and one without a dispatcher", () => {
      const dir = mkdtempSync(join(tmpdir(), "state-age-projects-")), sourcesPath = join(dir, "sources.json");
      writeFileSync(sourcesPath, JSON.stringify([{ root: dir, path: "tasks/current.md" }, { root: "/unknown/project", path: "TASKS.md" }]));
      return { dir, sourcesPath };
    }],
    when: ["resolving routes", f => ({ ...f, projects: readStateAgeProjects({ sourcesPath: f.sourcesPath,
      routes: [{ id: "cutkit", root: f.dir, ledger: "docs/TASKS.md", dispatcher: "lsrc:0", enabled: false, askPanels: ["claw:6"] }] }) })],
    then: ["the actual board path and specified age dispatcher win", f => {
      expect(f.projects[0]).toMatchObject({ id: "cutkit", ledger: "tasks/current.md", dispatcher: "lsrc:3", enabled: false });
      expect(f.projects[1]).toMatchObject({ root: "/unknown/project", dispatcher: null, ledger: "TASKS.md" });
      const text = stateAgeMessage({ kind: "row", row: "533c", title: "remove old generations", state: "working", ageMs: 25 * 3600000, limitMs: 24 * 3600000, reasons: ["state-age"] });
      expect(inferAskOrigin({ source: "state-age", prompt: text })).toBe("system");
      expect(isHumanAsk({ source: "pane-hook", verbatim: text })).toBe(false);
    }],
    cleanup: f => rmSync(f.dir, { recursive: true, force: true }),
  });
});
