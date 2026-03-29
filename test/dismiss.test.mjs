import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createAgent } from "../agent.mjs";

const noop = () => Promise.resolve();

function setup({ paneOutput = "" } = {}) {
  const tmuxExec = vi.fn(async () => ({ stdout: paneOutput }));
  const run = vi.fn(async () => ({ stdout: "" }));

  const { dismissBlockingPrompt, getResponse } = createAgent({
    tmuxExec,
    run,
    tmuxSocket: "/tmp/test.sock",
    agentBin: "/usr/bin/agent",
    delay: noop,
    timeout: 300000,
  });

  return { dismissBlockingPrompt, getResponse, tmuxExec, run };
}

feature("dismissBlockingPrompt", () => {
  unit("dismisses when feedback prompt is visible", {
    given: [
      "tmux pane showing feedback prompt",
      () => setup({
        paneOutput: "Some output\n1: Bad  2: Fine  3: Good\n0: Dismiss\n",
      }),
    ],
    when: [
      "checking for blocking prompt",
      ({ dismissBlockingPrompt }) => dismissBlockingPrompt("_api:.0"),
    ],
    then: [
      "returns true and sends dismiss keystroke (retries once since mock keeps returning survey)",
      (result, { tmuxExec }) => {
        expect(result).toBe(true);
        // 2 iterations × (capture + send-keys) = 4 calls
        expect(tmuxExec).toHaveBeenCalledTimes(4);
        expect(tmuxExec.mock.calls[1][0]).toContain("send-keys");
      },
    ],
  });

  unit("returns false when no prompt is visible", {
    given: [
      "tmux pane with normal output",
      () => setup({ paneOutput: "Normal Claude output\n❯ \n" }),
    ],
    when: [
      "checking for blocking prompt",
      ({ dismissBlockingPrompt }) => dismissBlockingPrompt("_api:.0"),
    ],
    then: [
      "returns false without sending keys",
      (result, { tmuxExec }) => {
        expect(result).toBe(false);
        expect(tmuxExec).toHaveBeenCalledTimes(1);
      },
    ],
  });
});

feature("getResponse", () => {
  unit("extracts text from tmux capture", {
    given: [
      "tmux pane with Claude text output",
      () => setup({
        paneOutput: "❯ what is 2+2?\n\n● The answer is 4.\n\n✻ Brewed for 2s\n\n❯",
      }),
    ],
    when: [
      "getting the response",
      ({ getResponse }) => getResponse("_api", 0),
    ],
    then: [
      "returns extracted text",
      (result) => expect(result).toBe("The answer is 4."),
    ],
  });

  unit("strips tool calls from response", {
    given: [
      "tmux pane with tool calls between text",
      () => setup({
        paneOutput: "❯ fix bug\n\n● Let me check.\n\n● Bash(ls)\n  ⎿  file.txt\n\n● Fixed it.\n\n❯",
      }),
    ],
    when: [
      "getting the response",
      ({ getResponse }) => getResponse("_api", 0),
    ],
    then: [
      "returns only text, no tool output",
      (result) => {
        expect(result).toContain("Let me check.");
        expect(result).toContain("Fixed it.");
        expect(result).not.toContain("Bash(");
        expect(result).not.toContain("file.txt");
      },
    ],
  });

  unit("returns fallback for empty output", {
    given: [
      "tmux pane with no Claude response",
      () => setup({ paneOutput: "❯ /clear\n\n❯" }),
    ],
    when: [
      "getting the response",
      ({ getResponse }) => getResponse("_api", 0),
    ],
    then: [
      "returns empty response fallback",
      (result) => expect(result).toBe("(empty response)"),
    ],
  });

  unit("handles different pane numbers", {
    given: [
      "tmux pane with response",
      () => setup({
        paneOutput: "❯ hello\n\n● Hi from pane 1!\n\n❯",
      }),
    ],
    when: [
      "getting response from pane 1",
      ({ getResponse }) => getResponse("_api", 1),
    ],
    then: [
      "capture-pane targets correct pane",
      (result, { tmuxExec }) => {
        expect(result).toBe("Hi from pane 1!");
        expect(tmuxExec.mock.calls[0][0]).toContain("_api:.1");
      },
    ],
  });
});
