import { unit, feature, expect } from "bdd-vitest";
import {
  parseModelList,
  parseEffortList,
  normalizeEffortLabel,
  findConfirmation,
  driveCodexModelPicker,
} from "./codex-model-picker.mjs";

// Fixtures captured live from codex-cli 0.144.1 (claw:9, 2026-07-10).
const MODEL_LIST = `
  Select Model and Effort
  Access legacy models by running codex -m <model_name> or in your config.toml

› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.
  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.
  3. gpt-5.6-luna           Fast and affordable agentic coding model.
  4. gpt-5.5                Frontier model for complex coding, research, and real-world work.
  5. gpt-5.4                Strong model for everyday coding.
  6. gpt-5.4-mini           Small, fast, and cost-efficient model for simpler coding tasks.
  7. gpt-5.3-codex-spark    Ultra-fast coding model.

  Press enter to confirm or esc to go back
`;

const EFFORT_LIST = `
  Select Reasoning Level for gpt-5.6-luna

  1. Low               Fast responses with lighter reasoning
› 2. Medium (default)  Balances speed and reasoning depth for everyday tasks
  3. High              Greater reasoning depth for complex problems
  4. Extra high        Extra high reasoning depth for complex problems
  5. Max               Maximum reasoning depth for the hardest problems

  Press enter to confirm or esc to go back
`;

const COMPOSER_VIEW = `
• Some earlier transcript line

› /model

  /model  choose what model and reasoning effort to use
`;

const IDLE_VIEW = `
• Some earlier transcript line

›
  gpt-5.6-sol xhigh · ~/x
`;

const CONFIRMED = `
• Model changed to gpt-5.6-luna low

› Run /review on my current changes
  gpt-5.6-luna low · ~/x
`;

feature("picker list parsing", () => {
  unit("model list rows carry digit, clean name and current-flag", {
    given: ["the live model list capture", () => ({ text: MODEL_LIST })],
    when: ["parsing", ({ text }) => parseModelList(text)],
    then: ["7 rows, sol is current, names have no suffixes", (rows) => {
      expect(rows).toHaveLength(7);
      expect(rows[0]).toMatchObject({ digit: "1", name: "gpt-5.6-sol", current: true });
      expect(rows[2]).toMatchObject({ digit: "3", name: "gpt-5.6-luna", current: false });
      expect(rows[6].name).toBe("gpt-5.3-codex-spark");
    }],
  });

  unit("effort list rows normalize labels and carry the pending model", {
    given: ["the live effort list capture", () => ({ text: EFFORT_LIST })],
    when: ["parsing", ({ text }) => parseEffortList(text)],
    then: ["model + 5 tiers incl. Extra high → xhigh", (r) => {
      expect(r.model).toBe("gpt-5.6-luna");
      expect(r.rows.map((x) => x.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(r.rows[3].digit).toBe("4");
    }],
  });

  unit("non-picker text parses to null, never to empty rows", {
    given: ["plain transcript text", () => ({ text: "• Ran git status\n› \n" })],
    when: ["parsing both views", ({ text }) => ({ m: parseModelList(text), e: parseEffortList(text) })],
    then: ["both null", (r) => {
      expect(r.m).toBeNull();
      expect(r.e).toBeNull();
    }],
  });

  unit("effort normalization: extra high beats plain high", {
    given: ["ambiguous labels", () => ({})],
    when: ["normalizing", () => ["Extra high", "High", "Medium (default)", "Low", "Max"].map(normalizeEffortLabel)],
    then: ["xhigh/high/medium/low/max", (r) =>
      expect(r).toEqual(["xhigh", "high", "medium", "low", "max"])],
  });

  unit("confirmation line is found and effort extracted", {
    given: ["post-switch transcript", () => ({ text: CONFIRMED })],
    when: ["searching", ({ text }) => findConfirmation(text, "gpt-5.6-luna")],
    then: ["model + effort", (r) => expect(r).toEqual({ model: "gpt-5.6-luna", effort: "low" })],
  });

  unit("confirmation for a DIFFERENT model does not count", {
    given: ["a stale confirmation for sol", () => ({ text: "• Model changed to gpt-5.6-sol xhigh\n" })],
    when: ["searching for luna", ({ text }) => findConfirmation(text, "gpt-5.6-luna")],
    then: ["null", (r) => expect(r).toBeNull()],
  });
});

// Scripted fake agent: capturePane returns the next queued frame; keystrokes
// are recorded so tests can assert exactly what was typed.
function fakeAgent({ frames, busy = false }) {
  const keys = [];
  let i = 0;
  return {
    keys,
    isBusy: async () => busy,
    capturePane: async () => frames[Math.min(i++, frames.length - 1)],
    typeLiteral: async (_n, text) => keys.push(text),
    sendEnter: async () => keys.push("<enter>"),
    sendEscape: async () => keys.push("<esc>"),
  };
}

const noSleep = () => Promise.resolve();

feature("driveCodexModelPicker", () => {
  unit("happy path: /model → digit 3 → digit 1 → confirmed luna low", {
    given: ["a pane scripted through all five stages", () => ({
      agent: fakeAgent({ frames: [IDLE_VIEW, COMPOSER_VIEW, MODEL_LIST, EFFORT_LIST, CONFIRMED] }),
    })],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-luna", effort: "low", sleep: noSleep,
    })],
    then: ["ok with the exact key sequence", (r, { agent }) => {
      expect(r).toMatchObject({ ok: true, model: "gpt-5.6-luna", effort: "low" });
      expect(agent.keys).toEqual(["/model", "<enter>", "3", "1"]);
    }],
  });

  unit("busy pane is refused before any keystroke", {
    given: ["a mid-turn pane", () => ({
      agent: fakeAgent({ frames: [COMPOSER_VIEW], busy: true }),
    })],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-luna", sleep: noSleep,
    })],
    then: ["fails at busy, zero keys typed", (r, { agent }) => {
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("busy");
      expect(agent.keys).toHaveLength(0);
    }],
  });

  unit("requested model absent from picker fails with the available list", {
    given: ["a picker without the target model", () => ({
      agent: fakeAgent({ frames: [IDLE_VIEW, COMPOSER_VIEW, MODEL_LIST, MODEL_LIST] }),
    })],
    when: ["driving toward a hidden model", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-9-plasma", sleep: noSleep,
    })],
    then: ["model-missing + escape unwind + honest availability", (r, { agent }) => {
      expect(r.stage).toBe("model-missing");
      expect(r.available).toContain("gpt-5.6-sol");
      expect(agent.keys.filter((k) => k === "<esc>").length).toBeGreaterThan(0);
    }],
  });

  unit("dirty composer (merged residue) aborts instead of submitting garbage", {
    given: ["a composer showing /usage/model", () => ({
      agent: fakeAgent({ frames: ["\n› /usage\n"] }),
    })],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-sol", sleep: noSleep,
    })],
    then: ["fails before typing, so the existing draft is preserved", (r, { agent }) => {
      expect(r.stage).toBe("compose");
      expect(agent.keys).not.toContain("/model");
      expect(agent.keys).not.toContain("<enter>");
    }],
  });

  unit("omitted effort accepts the picker default via Enter", {
    given: ["no effort requested", () => ({
      agent: fakeAgent({ frames: [IDLE_VIEW, COMPOSER_VIEW, MODEL_LIST, EFFORT_LIST,
        "• Model changed to gpt-5.6-luna medium\n"] }),
    })],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-luna", sleep: noSleep,
    })],
    then: ["confirms default effort with Enter as last key", (r, { agent }) => {
      expect(r).toMatchObject({ ok: true, effort: "medium" });
      expect(agent.keys[agent.keys.length - 1]).toBe("<enter>");
    }],
  });

  unit("busy-probe failure is fail-closed before any keystroke", {
    given: ["a pane whose busy state cannot be read", () => {
      const agent = fakeAgent({ frames: [IDLE_VIEW] });
      agent.isBusy = async () => { throw new Error("tmux unavailable"); };
      return { agent };
    }],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-sol", sleep: noSleep,
    })],
    then: ["fails at busy-check with zero keys typed", (r, { agent }) => {
      expect(r.stage).toBe("busy-check");
      expect(agent.keys).toHaveLength(0);
    }],
  });

  unit("a stale confirmation from an earlier switch is not accepted", {
    given: ["the effort view and final capture contain only the same stale line", () => {
      const stale = `• Model changed to gpt-5.6-luna low\n${EFFORT_LIST}`;
      return {
        agent: fakeAgent({ frames: [IDLE_VIEW, COMPOSER_VIEW, MODEL_LIST, stale, stale] }),
      };
    }],
    when: ["driving", ({ agent }) => driveCodexModelPicker({
      agent, name: "api", pane: 3, model: "gpt-5.6-luna", effort: "low", sleep: noSleep,
    })],
    then: ["fails confirmation instead of claiming success", (r) => {
      expect(r.stage).toBe("confirm");
      expect(r.ok).toBe(false);
    }],
  });
});
