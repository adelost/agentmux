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
    configPath: "/tmp/test-agents.yaml",
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
      "returns 'dismiss' and sends dismiss keystroke",
      (result, { tmuxExec }) => {
        expect(result).toBe("dismiss");
        // 1 capture + 1 send-keys = 2 calls
        expect(tmuxExec).toHaveBeenCalledTimes(2);
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
      "returns null without sending keys",
      (result, { tmuxExec }) => {
        expect(result).toBeNull();
        expect(tmuxExec).toHaveBeenCalledTimes(1);
      },
    ],
  });

  // --- Regression for 1.16.2: stale scrollback false positive --------------
  // Bug: dismissBlockingPrompt fired whenever "0: Dismiss" appeared anywhere
  // in the last 20 lines of scrollback — even after the survey was already
  // dismissed and the user was back at the input prompt. Each false fire
  // sent `'0' Enter` into a pane with no menu, so the "0" landed as literal
  // text. Combined with 4 dismiss call sites + a 3-attempt retry loop in
  // processMessage, users saw `❯ 0` injected 3-4× per Discord message.
  // Fix: matchers now check only the BOTTOM of the captured text and
  // require the rating row "1: ... 2: ... 3: ..." next to "0: Dismiss".

  unit("does NOT dismiss when survey only lingers in scrollback", {
    given: [
      "tmux pane where the feedback survey appeared earlier but user is now back at the input",
      () => setup({
        paneOutput:
          "● Earlier turn output\n" +
          "1: Bad  2: Fine  3: Good\n" +
          "0: Dismiss\n" +                 // ← stale survey in scrollback
          "● Survey dismissed, here's another response\n" +
          "● More output\n" +
          "❯ \n",                          // ← actual current screen state
      }),
    ],
    when: [
      "checking for blocking prompt",
      ({ dismissBlockingPrompt }) => dismissBlockingPrompt("_api:.0"),
    ],
    then: [
      "returns null and DOES NOT inject '0' Enter into the live input",
      (result, { tmuxExec }) => {
        expect(result).toBeNull();
        expect(tmuxExec).toHaveBeenCalledTimes(1); // only the capture, no send-keys
      },
    ],
  });

  unit("does NOT dismiss when chat content mentions '0: Dismiss' literally", {
    given: [
      "tmux pane where a previous response quoted the dismiss option in code",
      () => setup({
        paneOutput:
          '● To dismiss the survey, press "0: Dismiss" — but this is just docs\n' +
          "❯ \n",
      }),
    ],
    when: [
      "checking for blocking prompt",
      ({ dismissBlockingPrompt }) => dismissBlockingPrompt("_api:.0"),
    ],
    then: [
      "returns null because the rating row is absent",
      (result, { tmuxExec }) => {
        expect(result).toBeNull();
        expect(tmuxExec).toHaveBeenCalledTimes(1);
      },
    ],
  });

  unit("does NOT trigger resume when both phrases linger in scrollback", {
    given: [
      "tmux pane where the resume dialog was already confirmed earlier",
      () => setup({
        paneOutput:
          "Resume from summary? Press Enter to confirm\n" + // ← old dialog
          "● Resumed. Working on next task.\n" +
          "● Done.\n" +
          "❯ \n",
      }),
    ],
    when: [
      "checking for blocking prompt",
      ({ dismissBlockingPrompt }) => dismissBlockingPrompt("_api:.0"),
    ],
    then: [
      "returns null and does not send Enter into the live input",
      (result, { tmuxExec }) => {
        expect(result).toBeNull();
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
