import { feature, unit, expect } from "bdd-vitest";
import { cwdFromHookInput, pokePath, resolvePaneFromCwd } from "./reactive-poke.mjs";

const config = {
  lsrc: {
    dir: "/home/me/lsrc",
    panes: Array.from({ length: 8 }, (_, i) => ({ cmd: i < 3 ? "claude" : "bash" })),
  },
  ai: {
    dir: "/home/me/lsrc/ai-dsl",
    panes: [{ cmd: "claude" }, { cmd: "claude-2" }],
  },
};

feature("reactive poke: cwd to pane resolution", () => {
  unit("agent root resolves to pane 0", {
    when: ["resolving cwd", () => resolvePaneFromCwd("/home/me/lsrc/ai-dsl", config)],
    then: ["ai pane 0", (r) => expect(r).toEqual({ name: "ai", pane: 0, dir: "/home/me/lsrc/ai-dsl" })],
  });

  unit("nested cwd under agent root resolves to pane 0", {
    when: ["resolving cwd", () => resolvePaneFromCwd("/home/me/lsrc/ai-dsl/src/tools", config)],
    then: ["ai pane 0 wins over broad lsrc root", (r) =>
      expect(r).toEqual({ name: "ai", pane: 0, dir: "/home/me/lsrc/ai-dsl" })],
  });

  unit(".agents/N cwd resolves to that pane", {
    when: ["resolving cwd", () => resolvePaneFromCwd("/home/me/lsrc/ai-dsl/.agents/1/subdir", config)],
    then: ["ai pane 1", (r) => expect(r).toEqual({ name: "ai", pane: 1, dir: "/home/me/lsrc/ai-dsl" })],
  });

  unit("the generated .agents directory itself does not resolve to pane 0", {
    when: ["resolving cwd", () => resolvePaneFromCwd("/home/me/lsrc/ai-dsl/.agents", config)],
    then: ["no ambiguous target", (r) => expect(r).toBeNull()],
  });

  unit("unknown cwd returns null", {
    when: ["resolving cwd", () => resolvePaneFromCwd("/tmp/elsewhere", config)],
    then: ["no target", (r) => expect(r).toBeNull()],
  });
});

feature("reactive poke: hook input and route shape", () => {
  unit("prefers hook cwd", {
    when: ["reading hook input", () => cwdFromHookInput({ cwd: "/x" }, "/fallback")],
    then: ["cwd returned", (cwd) => expect(cwd).toBe("/x")],
  });

  unit("supports workspace current_dir", {
    when: ["reading hook input", () => cwdFromHookInput({ workspace: { current_dir: "/w" } }, "/fallback")],
    then: ["workspace current_dir returned", (cwd) => expect(cwd).toBe("/w")],
  });

  unit("builds encoded per-pane poke route", {
    when: ["building path", () => pokePath({ name: "my agent", pane: 2 })],
    then: ["agent and pane are encoded", (path) => expect(path).toBe("/api/poke/my%20agent/2")],
  });
});
