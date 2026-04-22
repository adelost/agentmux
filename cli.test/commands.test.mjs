import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseFlags, validateAgentAndPane } from "../cli/commands.mjs";

feature("parseFlags", () => {
  unit("extracts string flags", {
    given: ["args with -n channel", () => ["-n", "notify", "hello"]],
    when: ["parsing with string spec", (args) => parseFlags(args, { n: "string" })],
    then: ["flag extracted, rest is positional", ({ flags, positional }) => {
      expect(flags.n).toBe("notify");
      expect(positional).toEqual(["hello"]);
    }],
  });

  unit("extracts number flags", {
    given: ["args with -p 2", () => ["-p", "2", "prompt"]],
    when: ["parsing with number spec", (args) => parseFlags(args, { p: "number" })],
    then: ["flag is number", ({ flags, positional }) => {
      expect(flags.p).toBe(2);
      expect(positional).toEqual(["prompt"]);
    }],
  });

  unit("extracts boolean flags", {
    given: ["args with -q", () => ["-q", "prompt"]],
    when: ["parsing with boolean spec", (args) => parseFlags(args, { q: "boolean" })],
    then: ["flag is true", ({ flags, positional }) => {
      expect(flags.q).toBe(true);
      expect(positional).toEqual(["prompt"]);
    }],
  });

  unit("handles multiple flags", {
    given: ["args with -n, -p, -q", () => ["-n", "dev", "-p", "1", "-q", "fix bug"]],
    when: ["parsing", (args) => parseFlags(args, { n: "string", p: "number", q: "boolean" })],
    then: ["all flags extracted", ({ flags, positional }) => {
      expect(flags.n).toBe("dev");
      expect(flags.p).toBe(1);
      expect(flags.q).toBe(true);
      expect(positional).toEqual(["fix bug"]);
    }],
  });

  unit("handles --long flags", {
    given: ["args with --full", () => ["--full", "test"]],
    when: ["parsing", (args) => parseFlags(args, { full: "boolean" })],
    then: ["long flag extracted", ({ flags }) => expect(flags.full).toBe(true)],
  });

  unit("unknown flags become positional", {
    given: ["args with unknown flag", () => ["-x", "value"]],
    when: ["parsing with empty spec", (args) => parseFlags(args, {})],
    then: ["both in positional", ({ positional }) => expect(positional).toEqual(["-x", "value"])],
  });

  unit("no args returns empty", {
    given: ["empty args", () => []],
    when: ["parsing", (args) => parseFlags(args, { n: "string" })],
    then: ["empty flags and positional", ({ flags, positional }) => {
      expect(flags).toEqual({});
      expect(positional).toEqual([]);
    }],
  });
});

// --- validateAgentAndPane (foolproof errors for amux log) ------------------

feature("validateAgentAndPane", () => {
  let root;
  const setupConfig = () => {
    root = mkdtempSync(join(tmpdir(), "amux-validate-test-"));
    const path = join(root, "agents.yaml");
    writeFileSync(path, `
claw:
  dir: /tmp/claw
  panes:
    - name: claude
      cmd: claude
    - name: claude-2
      cmd: claude
    - name: shell-1
      cmd: bash
ai:
  dir: /tmp/ai
  panes:
    - name: claude
      cmd: claude
`);
    return { configPath: path };
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  unit("valid agent + in-bounds pane: no throw", {
    given: ["valid config", setupConfig],
    when: ["validating claw pane 1", (ctx) => {
      try { validateAgentAndPane(ctx, "claw", 1); return null; }
      catch (e) { return e.message; }
    }],
    then: ["no error", (r) => { expect(r).toBeNull(); cleanup(); }],
  });

  unit("pane out of bounds: error mentions valid range", {
    given: ["valid config", setupConfig],
    when: ["validating claw pane 9", (ctx) => {
      try { validateAgentAndPane(ctx, "claw", 9); return null; }
      catch (e) { return e.message; }
    }],
    then: ["error mentions '3 panes (0-2)'", (r) => {
      expect(r).toContain("pane 9 does not exist");
      expect(r).toContain("claw");
      expect(r).toContain("3 pane");
      expect(r).toContain("0-2");
      cleanup();
    }],
  });

  unit("colon in agent name: rejected with helpful hint", {
    given: ["valid config", setupConfig],
    when: ["validating 'claw:0'", (ctx) => {
      try { validateAgentAndPane(ctx, "claw:0", 0); return null; }
      catch (e) { return e.message; }
    }],
    then: ["error suggests '-p N' form", (r) => {
      expect(r).toContain("don't contain ':'");
      expect(r).toContain("amux claw -p 0");
      cleanup();
    }],
  });

  unit("unknown agent: lists known agents", {
    given: ["valid config with claw+ai", setupConfig],
    when: ["validating 'ghost'", (ctx) => {
      try { validateAgentAndPane(ctx, "ghost", 0); return null; }
      catch (e) { return e.message; }
    }],
    then: ["lists ai + claw", (r) => {
      expect(r).toContain("unknown agent 'ghost'");
      expect(r).toContain("ai");
      expect(r).toContain("claw");
      cleanup();
    }],
  });

  unit("negative pane: rejected", {
    given: ["valid config", setupConfig],
    when: ["validating pane -1", (ctx) => {
      try { validateAgentAndPane(ctx, "claw", -1); return null; }
      catch (e) { return e.message; }
    }],
    then: ["error mentions invalid pane", (r) => {
      expect(r).toContain("-1");
      expect(r).toContain("does not exist");
      cleanup();
    }],
  });
});
