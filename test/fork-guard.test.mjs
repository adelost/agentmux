import { component, expect, feature } from "bdd-vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Mattias 2026-10-10: "vi borde väl förbjuda det helt, det är bättre. Alltså fine att man har en subagent som har
// tomt kontext eller bara vet vad den ska göra". 9 forks of api:0 re-read 195k-443k of copied context per call.
const runGuard = (input) => spawnSync(process.execPath, [resolve("bin/fork-guard.mjs")], {
  input: JSON.stringify({ tool_name: "Agent", tool_input: { description: "x", prompt: "y", ...input } }),
  encoding: "utf8",
});

feature("subagent fork guard", () => {
  component("a fork is refused and the agent is told what to start instead", {
    when: ["an agent asks for a fork", () => runGuard({ subagent_type: "fork" })],
    then: ["the call is blocked and names a fresh subagent with a brief", (result) => {
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/BLOCKED: Forks are banned/u);
      expect(result.stderr).toMatch(/fresh subagent[\s\S]*brief/u);
    }],
  });

  component("a fresh subagent still starts", {
    when: ["an agent asks for a general-purpose subagent", () => runGuard({ subagent_type: "general-purpose" })],
    then: ["the call goes through", (result) => expect([result.status, result.stderr]).toEqual([0, ""])],
  });
});
