import { feature, unit, expect } from "bdd-vitest";
import { checkFleetPolicy } from "../bin/check-fleet-policy.mjs";

const path = "/installed/agentmux/docs/fleet/context.md";
const rule = 'Never fork a session (Mattias 2026-10-10: "vi borde väl förbjuda det helt").';
const register = `## Orient, then act\n\nBefore a compact: read [context.md](${path}).`;

feature("lossless fleet policy relocation", () => {
  unit("a dated quote survives in a directly linked file with different wrapping", {
    when: ["checking the old paragraph against its relocated text", () =>
      checkFleetPolicy(rule, register, () => rule.replace("(Mattias", "\n(Mattias"))],
    then: ["all words, date and quote remain reachable", (result) => {
      expect(result).toEqual({ ok: true, paragraphs: 1, files: [path], missing: [] });
    }],
  });
  unit("removing a dated rule refuses the relocation", {
    when: ["the linked file loses the old rule", () => checkFleetPolicy(rule, register, () => "")],
    then: ["the exact missing paragraph is named", (result) => {
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([rule]);
    }],
  });
  unit("an unlinked archive does not count as preservation", {
    when: ["the old rule exists somewhere outside the register", () => checkFleetPolicy(rule, "short register", () => rule)],
    then: ["the unreachable rule is missing", (result) => expect(result.ok).toBe(false)],
  });
  unit("a missing linked document fails with its actual path", {
    when: ["reading a broken link", () => () => checkFleetPolicy(rule, register, (file) => { throw new Error(`ENOENT ${file}`); })],
    then: ["no silent successful archive", (run) => expect(run).toThrow(path)],
  });
});
