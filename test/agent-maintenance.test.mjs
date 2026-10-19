import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../agent.mjs";

const RULE = "─".repeat(84);
const shortFooter = (composer) => `❯ ${composer}\n────────\nOpus 5 thinking: xhigh`;
// lsrc:1 on 2026-09-28: Claude lists background agents under its footer, so
// the composer is the seventh line from the bottom.
const withAgentList = (composer) => [
  "                                                                     744400 tokens",
  RULE, `❯ ${composer}`, RULE,
  "  ⬆ /gsd-update │ Opus 5.5 │ 1 💀 ████████░░ 89% · thinking: max",
  "  ⏵⏵ bypass permissions on · 2 shells · ← for agents",
  "",
  "  ● main",
  "  ◯ general-purpose  Appending port-collision lesson… 1h 31m 36s · ↓ 601.7k tokens",
].join("\n");

/**
 * A Claude pane whose composer follows typed text, backspaces and Enter. A
 * `suggestion` is grey text shown in an empty composer until the first keystroke.
 */
function claudePane({ screen = shortFooter, composer = "", copyMode = false, suggestion = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-maintenance-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `probe:\n  dir: ${root}\n  panes:\n    - {cmd: claude}\n`);
  const pane = { calls: [], composer, submitted: null };
  const agent = createAgent({ configPath, tmuxSocket: "/unused", delay: async () => {},
    run: async () => ({ stdout: "" }),
    tmuxExec: async (command) => {
      pane.calls.push(command);
      if (command.includes("pane_current_command")) return { stdout: "claude\n" };
      if (command.includes("pane_in_mode")) return { stdout: copyMode ? "1\n" : "0\n" };
      if (command.includes("capture-pane")) return { stdout: screen(pane.composer || suggestion || "") };
      const typed = command.match(/ -l -- '(.*)'$/u);
      if (typed) { pane.composer += typed[1]; suggestion = null; }
      const erased = (command.match(/\bBSpace\b/gu) || []).length;
      if (erased) pane.composer = pane.composer.slice(0, Math.max(0, pane.composer.length - erased));
      if (/send-keys.* Enter$/u.test(command)) { pane.submitted = pane.composer; pane.composer = ""; }
      return { stdout: "" };
    },
  });
  return { agent, pane, clean: () => rmSync(root, { recursive: true, force: true }) };
}

async function maintenanceCompact(setup, failure = null) {
  const { agent, pane, clean } = claudePane(setup);
  const stages = [];
  let error = null;
  try {
    await agent.sendOnly("probe", "/compact", 0, { existingOnly: true,
      maintenanceGuard: async (stage) => { stages.push(stage); if (stage === failure) throw new Error(`changed-${stage}`); },
    });
  } catch (caught) { error = caught.message; }
  finally { clean(); }
  return { ...pane, stages, error, typed: pane.calls.filter((call) => / -l -- /u.test(call)).length };
}

feature("maintenance transport never repairs or starts a pane", () => {
  for (const failure of ["paste", "submit", "copy-mode", null]) {
    component(`existing-only transport with ${failure || "one successful submit"}`, {
      when: ["sending through the real shared agent transport", () =>
        maintenanceCompact({ copyMode: failure === "copy-mode" }, failure)],
      then: ["it never restarts, clears, dismisses, or repeats Enter", ({ calls, stages, error, typed, submitted }) => {
        expect(calls.some((call) => /new-session|respawn-pane|split-window|show-environment|C-u|C-c|Escape|-X cancel/u.test(call))).toBe(false);
        if (failure === "paste" || failure === "copy-mode") expect(typed).toBe(0);
        if (failure) { expect(error).toBeTruthy(); expect(submitted).toBeNull(); }
        else { expect(error).toBeNull(); expect(stages).toEqual(["paste", "submit"]); expect(submitted).toBe("/compact"); }
        expect(calls.filter((call) => /send-keys.* Enter$/u.test(call))).toHaveLength(failure ? 0 : 1);
      }],
    });
  }
});

feature("maintenance leaves no command of its own in the composer", () => {
  // lsrc:1, 2026-09-28: maintenance typed /compact, its last check refused
  // Enter, and the text stayed. Mattias's next question went out as
  // "/compact/compact[…] Hej, var är ni någonstans?".
  component("a refused submit erases exactly the command it typed", {
    when: ["the last check before Enter refuses", () => maintenanceCompact({}, "submit")],
    then: ["the composer is empty again and nothing was sent", ({ composer, submitted, error, calls }) => {
      expect(error).toBe("changed-submit");
      expect(submitted).toBeNull();
      expect(composer).toBe("");
      expect(calls.filter((call) => /\bBSpace\b/u.test(call))).toHaveLength(1);
    }],
  });

  component("a check that refuses before typing erases nothing", {
    when: ["the check before typing refuses", () => maintenanceCompact({ composer: "half a human draft" }, "paste")],
    then: ["the draft is untouched", ({ composer, calls }) => {
      expect(composer).toBe("half a human draft");
      expect(calls.some((call) => /\bBSpace\b/u.test(call))).toBe(false);
    }],
  });
});

feature("Claude's composer is found above its background-agent list", () => {
  component("the command amux typed counts as drafted", {
    when: ["reading the transport state of a typed /compact", async () => {
      const { agent, clean } = claudePane({ screen: withAgentList, composer: "/compact" });
      try { return await agent.promptTransportState("probe", 0, "/compact"); } finally { clean(); }
    }],
    then: ["the last check before Enter can pass", (transport) => expect(transport.state).toBe("drafted")],
  });

  component("a retry submits the command already typed instead of typing it again", {
    when: ["maintenance compacts while /compact is still in the composer", () =>
      maintenanceCompact({ screen: withAgentList, composer: "/compact" })],
    then: ["exactly one /compact is sent", ({ submitted, typed, error }) => {
      expect(error).toBeNull();
      expect(typed).toBe(0);
      expect(submitted).toBe("/compact");
    }],
  });
});

async function deliver(setup, prompt) {
  const { agent, pane, clean } = claudePane(setup);
  let error = null;
  try { await agent.sendOnly("probe", prompt, 0, { existingOnly: true }); }
  catch (caught) { error = caught.message; }
  finally { clean(); }
  return { ...pane, error };
}

feature("a delivery never types after text amux did not write", () => {
  const question = "[transcribed voice] Hej, var är ni någonstans?";

  // lsrc:1, 2026-09-28: "/compact/compact" sat in the composer and Mattias's
  // question went out as "/compact/compact[…] Hej, var är ni någonstans?".
  component("a draft in the composer holds the message and stays untouched", {
    when: ["delivering while the composer holds a short draft", () =>
      deliver({ screen: withAgentList, composer: "/compact/compact" }, question)],
    then: ["nothing is sent and the draft is exactly as it was", ({ error, submitted, composer }) => {
      expect(error).toMatch(/composer holds a draft/u);
      expect(submitted).toBeNull();
      expect(composer).toBe("/compact/compact");
    }],
  });

  component("a grey suggestion in an empty composer does not hold the message", {
    when: ["delivering while Claude suggests a next prompt", () =>
      deliver({ screen: withAgentList, suggestion: "run the tests" }, question)],
    then: ["exactly the message is sent", ({ error, submitted }) => {
      expect(error).toBeNull();
      expect(submitted).toBe(question);
    }],
  });

  component("an empty composer is typed into without a probe", {
    when: ["delivering into an empty composer", () => deliver({ screen: withAgentList }, question)],
    then: ["exactly the message is sent with no erase", ({ error, submitted, calls }) => {
      expect(error).toBeNull();
      expect(submitted).toBe(question);
      expect(calls.some((call) => /\bBSpace\b/u.test(call))).toBe(false);
    }],
  });
});

// lsrc:0 2026-10-19 (claw:2): a delivery that is cancelled after amux typed its text either clears that text or
// submits it. Text typed by this attempt is erased when the cancellation reaches the submit fence; any other
// refusal keeps the draft, which the next attempt recovers.
const cancelRefusal = () => Object.assign(new Error("delivery cancellation requested before submit fence"),
  { code: "AMUX_DELIVERY_CANCEL_REQUESTED" });

async function refusedAtFence(setup, prompt, refusal, options = {}) {
  const { agent, pane, clean } = claudePane(setup);
  let error = null;
  try {
    await agent.sendOnly("probe", prompt, 0, { existingOnly: true, ...options,
      onSubmitting: async () => { throw refusal; } });
  } catch (caught) { error = caught; }
  finally { clean(); }
  return { ...pane, error, erases: pane.calls.filter((call) => /\bBSpace\b/u.test(call)).length };
}

feature("a cancelled delivery leaves no text of its own in the composer", () => {
  const question = "[transcribed voice] Hej, var är ni någonstans?";

  component("a cancellation between paste and Enter erases exactly what this attempt typed", {
    when: ["the sender cancels while the submit fence is checked", () =>
      refusedAtFence({ screen: withAgentList }, question, cancelRefusal())],
    then: ["the composer is empty again, nothing was sent and the cancellation still reaches the broker", ({ composer, submitted, error, erases }) => {
      expect(composer).toBe("");
      expect(submitted).toBeNull();
      expect(error.code).toBe("AMUX_DELIVERY_CANCEL_REQUESTED");
      expect(erases).toBe(1);
    }],
  });

  component("any other refusal at the fence keeps the draft for the next attempt", {
    when: ["the fence fails for a reason that is not a cancellation", () =>
      refusedAtFence({ screen: withAgentList }, question, new Error("queue disk is full"))],
    then: ["the typed text stays and nothing was sent", ({ composer, submitted, error, erases }) => {
      expect(composer).toBe(question);
      expect(submitted).toBeNull();
      expect(error.message).toBe("queue disk is full");
      expect(erases).toBe(0);
    }],
  });

  component("a cancellation never erases a draft from an earlier attempt", {
    when: ["the sender cancels while the composer holds the text an earlier attempt typed", () =>
      refusedAtFence({ screen: withAgentList, composer: question }, question, cancelRefusal(), { knownDrafted: true })],
    then: ["the draft is left for the broker to withdraw once it proves the text is its own", ({ composer, erases }) => {
      expect(composer).toBe(question);
      expect(erases).toBe(0);
    }],
  });
});
