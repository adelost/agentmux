import { component, feature, unit, expect } from "bdd-vitest";
import { afterEach } from "vitest";
import { claudeShape, heuristicFindings, layerDuplicates, protectedLines, removedProtected } from "./rules-lint-text.mjs";
import { gitRead } from "./rules-lint.mjs";
import { commit, createRepo, createWorld, push, removeWorld } from "../test/rules-lint-world.mjs";

// Guards: I-3 and R-3 (his words are never duplicate candidates), UC-5 (layer duplicates), UC-6 (his words are
// listed and a removal is an error), R-5 (a rule file the setting does not reach).
const worlds = [];
afterEach(() => { for (const world of worlds.splice(0)) removeWorld(world); });

const SHARED = [
  "# Shared layer",
  "## Orient",
  "- Pick one option and say which evidence or criterion made it win, never leave it up to the reader.",
  "- Check a claim before stating it as fact: read the code path, the log, or reproduce it.",
].join("\n");
const SHARED_LAYER = [{ name: "the shared layer", label: ".agents/CLAUDE.md", text: SHARED }];
const REPEATED = "Pick one option and say which evidence or criterion made it win, never leave it up to the reader.";

const AGENTS = { file: "AGENTS.md", text: "# Rules\nline one\nline two\n" };
const claude = (text, extra = {}) => ({ file: "CLAUDE.md", text, ...extra });

const HIS_WORDS = `- Mattias 2026-10-19: "never skip the gate on a friday", said twice.`;
const gitFor = (repo) => (args) => gitRead(repo.root, args);

feature("rules lint text checks", () => {
  unit("lists his dated words as protected", {
    given: ["lines with a quote and a date, a quote alone, a date alone and a short quote", () => [
      HIS_WORDS,
      `Quote without a date or a name: "keep the tests small and fast".`,
      "On 2026-10-19 the gate changed.",
      `Mattias said "no" to it.`,
      "Mattias asked for “fast small tests” on 2026-10-20.",
      "Plain rule text with no quote at all.",
    ].join("\n")],
    when: ["listing protected lines", (text) => protectedLines(text)],
    then: ["only the quote-plus-date lines are listed, curly quotes included", (found) => {
      expect(found.map((p) => p.line)).toEqual([1, 5]);
    }],
  });

  unit("flags a sentence the shared layer already has", {
    given: ["a rule file with a near-copy, an unrelated sentence and a short line", () => [
      "# Repo rules",
      "- Always pick one option and say which evidence or criterion made it win, never leave it to the reader.",
      "- The orchestrator keeps one active feature per agent and never stacks work on a busy pane.",
      "- Short line.",
    ].join("\n")],
    when: ["comparing it with the layer", (text) => layerDuplicates(text, SHARED_LAYER)],
    then: ["only the near-copy is flagged, with the layer line and the share", (found) => {
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ line: 2, layerLine: 3, layer: { name: "the shared layer", label: ".agents/CLAUDE.md" } });
      expect(found[0].share).toBeGreaterThanOrEqual(0.6);
    }],
  });

  unit("never lists a protected line as a duplicate", {
    given: ["his dated quote of a shared rule and, as control, the same words unquoted", () => [
      `Mattias 2026-10-19: "${REPEATED}"`,
      REPEATED,
    ].join("\n")],
    when: ["comparing it with the layer", (text) => layerDuplicates(text, SHARED_LAYER)],
    then: ["only the unprotected control line is a candidate", (found) => {
      expect(found.map((f) => f.line)).toEqual([2]);
    }],
  });

  component("errors on a removed protected line", {
    given: ["a trunk where one commit removed his dated quote and nothing else holds it", () => {
      const world = createWorld(); worlds.push(world);
      const repo = createRepo(world, "removed");
      commit(repo, { "AGENTS.md": `# Rules\n${HIS_WORDS}\n- other rule\n` }, "add rules");
      const removal = commit(repo, { "AGENTS.md": "# Rules\n- other rule\n" }, "tidy rules");
      push(repo);
      return { repo, removal };
    }],
    when: ["checking the last 90 days of the rule file", ({ repo }) => removedProtected(gitFor(repo), "origin/main", "AGENTS.md")],
    then: ["the removing commit is named with the old line number", (found, { removal }) => {
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ commit: removal, lines: [2] });
    }],
  });

  component("accepts a protected line moved to another file", {
    given: ["a trunk where one commit moved one of his dated quotes to docs/ and dropped another", () => {
      const world = createWorld(); worlds.push(world);
      const repo = createRepo(world, "moved");
      const moved = HIS_WORDS;
      const lost = '- Mattias 2026-10-21: "never mix two features in one commit", said once.';
      commit(repo, { "AGENTS.md": `# Rules\n${moved}\n- other rule\n${lost}\n` }, "add rules");
      commit(repo, { "AGENTS.md": "# Rules\n- other rule\n", "docs/his-words.md": `# His words\n${moved}\n` }, "move one, drop one");
      push(repo);
      return { repo };
    }],
    when: ["checking the rule file", ({ repo }) => removedProtected(gitFor(repo), "origin/main", "AGENTS.md")],
    then: ["only the dropped quote is lost, the moved one is accepted", (found) => {
      expect(found).toHaveLength(1);
      expect(found[0].lines).toEqual([4]);
    }],
  });

  unit("errors on a symlinked or copied CLAUDE.md", {
    given: ["CLAUDE.md as a symlink, a copy, a pointer link and, as controls, an import and its own rules", () => ({
      symlink: claudeShape({ agents: AGENTS, claudes: [claude("AGENTS.md", { symlink: true, target: "AGENTS.md" })], setting: true }),
      copy: claudeShape({ agents: AGENTS, claudes: [claude("# Rules\nline one\nline two\n")], setting: true }),
      pointer: claudeShape({ agents: AGENTS, claudes: [claude("# Claude\n\nSee [AGENTS.md](AGENTS.md) for the rules.\n")], setting: true }),
      importOnly: claudeShape({ agents: AGENTS, claudes: [claude("@AGENTS.md\n")], setting: true }),
      ownRules: claudeShape({ agents: AGENTS, claudes: [claude("# Claude only\n\nSee [AGENTS.md](AGENTS.md).\n\n- one rule\n- another rule\n- a third rule\n")], setting: true }),
    })],
    when: ["classifying each shape", (shapes) => shapes],
    then: ["the three duplicates are errors and the controls are fine", (shapes) => {
      expect(shapes.symlink).toEqual([expect.objectContaining({ tag: "shape", file: "CLAUDE.md", msg: expect.stringMatching(/symlink/) })]);
      expect(shapes.copy).toEqual([expect.objectContaining({ tag: "shape", msg: expect.stringMatching(/copy/) })]);
      expect(shapes.pointer).toEqual([expect.objectContaining({ tag: "shape", msg: expect.stringMatching(/link/) })]);
      expect(shapes.importOnly).toEqual([]);
      expect(shapes.ownRules).toEqual([]);
    }],
  });

  unit("errors on a repo with only CLAUDE.md", {
    given: ["a repo with CLAUDE.md alone, .claude/CLAUDE.md alone and no rule file", () => ({
      top: claudeShape({ agents: null, claudes: [claude("rules")], setting: true }),
      nested: claudeShape({ agents: null, claudes: [{ file: ".claude/CLAUDE.md", text: "rules" }], setting: true }),
      none: claudeShape({ agents: null, claudes: [], setting: true }),
    })],
    when: ["classifying each shape", (shapes) => shapes],
    then: ["Codex coverage is an error only when a Claude file exists", (shapes) => {
      expect(shapes.top).toEqual([expect.objectContaining({ tag: "codex", file: "CLAUDE.md", msg: expect.stringMatching(/Codex reads none of these rules/) })]);
      expect(shapes.nested).toEqual([expect.objectContaining({ tag: "codex", file: ".claude/CLAUDE.md" })]);
      expect(shapes.none).toEqual([]);
    }],
  });

  unit("errors when neither the setting nor an import loads AGENTS.md", {
    given: ["the setting missing with no import, with an import, and the setting present", () => ({
      neither: claudeShape({ agents: AGENTS, claudes: [claude("# Own rules\n- one\n- two\n- three\n")], setting: false }),
      agentsOnly: claudeShape({ agents: AGENTS, claudes: [], setting: false }),
      imported: claudeShape({ agents: AGENTS, claudes: [claude("@AGENTS.md\n")], setting: false }),
      parentImport: claudeShape({ agents: AGENTS, claudes: [{ file: ".claude/CLAUDE.md", text: "@../AGENTS.md\n" }], setting: false }),
      withSetting: claudeShape({ agents: AGENTS, claudes: [claude("# Own rules\n- one\n- two\n- three\n")], setting: true }),
    })],
    when: ["classifying each case", (cases) => cases],
    then: ["only the case that nothing loads is an error", (cases) => {
      expect(cases.neither).toEqual([expect.objectContaining({ tag: "reach", msg: expect.stringMatching(/^Claude does not load AGENTS\.md here/) })]);
      expect(cases.agentsOnly).toEqual([expect.objectContaining({ tag: "reach" })]);
      expect([cases.imported, cases.parentImport, cases.withSetting]).toEqual([[], [], []]);
    }],
  });

  unit("count warns on a line count and a handler count", {
    given: ["lines with counts that rot and one without", () => [
      "The router file (295 lines) holds the table.",
      "`app.py` - 72 task handlers.",
      "No numbers on this line.",
      "Nine of 9 components are done.",
    ].join("\n")],
    when: ["running the heuristics", (text) => heuristicFindings(text).filter((f) => f.tag === "count")],
    then: ["each count is found on its own line", (found) => {
      expect(found.map((f) => f.line)).toEqual([1, 2, 4]);
      expect(found[1].msg).toBe('"72 task handlers" is a count that rots');
    }],
  });

  unit("status warns on a claim without a date", {
    given: ["status claims with and without a date", () => [
      "The sync is not deployed yet.",
      "The bridge is switched off (2026-10-19).",
      "It waits for review.",
      "All good here.",
    ].join("\n")],
    when: ["running the heuristics", (text) => heuristicFindings(text).filter((f) => f.tag === "status")],
    then: ["only the undated claims are flagged", (found) => expect(found.map((f) => f.line)).toEqual([1, 3])],
  });

  unit("size warns on a rule file over 30 KB", {
    given: ["a 31 KB and a 29 KB rule file", () => ({
      big: "a rule line\n".repeat(Math.ceil((31 * 1024) / 12)),
      small: "a rule line\n".repeat(Math.floor((29 * 1024) / 12)),
    })],
    when: ["running the heuristics", ({ big, small }) => ({
      big: heuristicFindings(big).filter((f) => f.tag === "size"),
      small: heuristicFindings(small).filter((f) => f.tag === "size"),
    })],
    then: ["only the big file warns", (found) => {
      expect(found.big).toHaveLength(1);
      expect(found.small).toEqual([]);
    }],
  });
});
