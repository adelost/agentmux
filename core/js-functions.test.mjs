import { expect, feature, unit } from "bdd-vitest";
import { parseChangedRanges, touchedFunctions } from "./hotspots.mjs";
import { jsFunctions } from "./js-functions.mjs";

// Shape of core/dream-owner.mjs where lizard let readTailLines swallow the file (claw:1, 1.25.67):
// lizard 1.24 loses the function end after a nested ternary with an empty string arm.
const DREAM_OWNER_SHAPE = `const CODING_ENGINE = /(?:^|[\\s/])(claude|codex)(?:\\s|$)/u;

function readTailLines(path) {
  let fd;
  try {
    fd = open(path);
    const text = read(fd);
    const firstNewline = text.indexOf("\\n");
    return (firstNewline === 0 ? text : firstNewline < 0 ? "" : text.slice(firstNewline + 1)).split("\\n");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { close(fd); } catch {} }
  }
}

function resolveConfiguredPane(config, pane) {
  const engine = String(config?.cmd || "").match(CODING_ENGINE)?.[1] || null;
  return { engine, pane };
}

export function dreamOwnerPrompt({ agent }) {
  return [
    "Dream owner " + agent,
    "Write the digest.",
  ].join("\\n");
}
`;

feature("JS and TS function spans", () => {
  unit("optional chaining into an index does not let one function swallow the next ones", {
    given: ["the dream-owner file shape", () => DREAM_OWNER_SHAPE],
    when: ["reading spans and which function a prompt-line edit touches", (source) => {
      const functions = jsFunctions("core/dream-owner.mjs", source);
      const diff = "--- a/core/dream-owner.mjs\n+++ b/core/dream-owner.mjs\n@@ -23 +23 @@";
      return { spans: functions.map((fn) => `${fn.name} ${fn.start}-${fn.end}`), touched: touchedFunctions(functions, parseChangedRanges(diff)) };
    }],
    then: ["each function ends where it ends, and only dreamOwnerPrompt is touched", ({ spans, touched }) => {
      expect(spans).toEqual(["readTailLines 3-15", "resolveConfiguredPane 17-20", "dreamOwnerPrompt 22-27"]);
      expect(touched.map((fn) => fn.name)).toEqual(["dreamOwnerPrompt"]);
    }],
  });

  unit("functions are named the way a reader calls them", {
    given: ["declarations, assigned arrows, methods and callbacks in TypeScript", () => `
export const createRig = ({ camera }: { camera: string }) => {
  const step = (dt: number) => dt;
  return { update() { return step(1); }, reset: function () {} };
};
class Director { #pick() {} choose(shots: string[]) { return shots.map((shot) => shot); } }
module.exports.run = async () => {};
`],
    when: ["reading names", (source) => jsFunctions("src/rig.ts", source).map((fn) => fn.name)],
    then: ["variables, properties, methods and members name them; bare callbacks stay anonymous", (names) => {
      expect(names).toEqual(["createRig", "step", "update", "reset", "#pick", "choose", "(anonymous)", "run"]);
    }],
  });
});
