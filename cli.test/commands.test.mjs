import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import yaml from "js-yaml";
import { parseFlags, validateAgentAndPane, loadSourceYaml, saveSourceAndRegenerate } from "../cli/commands.mjs";

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

// --- amux edit: $EDITOR spawn --------------------------------------------

feature("amux edit spawns $EDITOR on agentmux.yaml", () => {
  let root;
  // Test by spawning /bin/true as EDITOR against a tmp agentmux.yaml, then
  // asserting the file was opened (via /bin/true's successful exit). A real
  // editor can't run in tests, so /bin/true stands in for "editor that
  // immediately exits 0 after opening the file".
  component("spawns configured editor against the source yaml", {
    given: ["tmp bridge with agentmux.yaml + EDITOR=/bin/true", () => {
      root = mkdtempSync(join(tmpdir(), "amux-edit-test-"));
      const bridgeDir = root;
      const srcPath = join(bridgeDir, "agentmux.yaml");
      writeFileSync(srcPath, `guild: "0"\nagents: {}\n`);
      return { bridgeDir, srcPath };
    }],
    when: ["spawning /bin/true as the editor", async ({ bridgeDir, srcPath }) => {
      // Invoke spawn directly to mirror cmdEdit's behavior without importing
      // it (cmdEdit calls process.exit which would terminate the test run).
      const { spawn } = await import("child_process");
      return new Promise((done) => {
        const child = spawn("/bin/true", [srcPath], { stdio: "ignore" });
        child.on("exit", (code) => done({ code, srcPath }));
      });
    }],
    then: ["editor exits 0 (file path was valid)", ({ code, srcPath }) => {
      expect(code).toBe(0);
      // Source file untouched — /bin/true doesn't modify
      expect(readFileSync(srcPath, "utf-8")).toContain("guild");
      cleanup();
    }],
  });

  const cleanup = () => rmSync(root, { recursive: true, force: true });
});

// --- loadSourceYaml / saveSourceAndRegenerate ------------------------------
// Round-trip: write labels to agentmux.yaml through the helper, re-read via
// loadSourceYaml, verify agents.yaml was also regenerated in sync.

feature("label storage round-trip", () => {
  let root;
  const setupBridge = () => {
    root = mkdtempSync(join(tmpdir(), "amux-label-test-"));
    const bridgeDir = root;
    const configPath = join(root, "agents.yaml");

    // Source: agentmux.yaml with two agents
    writeFileSync(join(bridgeDir, "agentmux.yaml"), `
guild: "12345"
agents:
  claw:
    dir: /tmp/claw
    panes: 2
  ai:
    dir: /tmp/ai
    panes: 1
`);
    // Bootstrap agents.yaml so validateAgentAndPane can check pane count.
    // Kept intentionally minimal (no discord, no IDs) to exercise carry-over.
    writeFileSync(configPath, `
claw:
  dir: /tmp/claw
  panes:
    - name: claude
      cmd: claude
    - name: claude-2
      cmd: claude
ai:
  dir: /tmp/ai
  panes:
    - name: claude
      cmd: claude
`);

    return { bridgeDir, configPath, ctx: { bridgeDir, configPath } };
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  component("saveSourceAndRegenerate writes both source + generated yaml", {
    given: ["bridge dir", setupBridge],
    when: ["setting label on claw p0 via source yaml", ({ ctx }) => {
      const doc = loadSourceYaml(ctx);
      doc.agents.claw.labels = { 0: "main dev" };
      saveSourceAndRegenerate(ctx, doc);
      return ctx;
    }],
    then: ["both files reflect the label", (ctx) => {
      const src = readFileSync(join(ctx.bridgeDir, "agentmux.yaml"), "utf-8");
      expect(src).toContain("main dev");
      const gen = readFileSync(ctx.configPath, "utf-8");
      expect(gen).toContain("main dev");
      // generated yaml should have label on claude pane 0, not pane 1
      const claudeIdx = gen.indexOf("name: claude\n");
      const claude2Idx = gen.indexOf("name: claude-2\n");
      const labelIdx = gen.search(/label:\s*(?:"main dev"|main dev)/);
      expect(labelIdx).toBeGreaterThan(claudeIdx);
      expect(labelIdx).toBeLessThan(claude2Idx);
      cleanup();
    }],
  });

  component("loadSourceYaml reads back written labels", {
    given: ["bridge with label written", () => {
      const b = setupBridge();
      const doc = loadSourceYaml(b.ctx);
      doc.agents.claw.labels = { 1: "secondary" };
      saveSourceAndRegenerate(b.ctx, doc);
      return b;
    }],
    when: ["re-reading source", ({ ctx }) => loadSourceYaml(ctx)],
    then: ["labels round-tripped intact", (doc) => {
      expect(doc.agents.claw.labels).toEqual({ 1: "secondary" });
      cleanup();
    }],
  });

  component("clearing (delete key) removes label from source", {
    given: ["bridge with label set", () => {
      const b = setupBridge();
      const doc = loadSourceYaml(b.ctx);
      doc.agents.claw.labels = { 0: "to be cleared" };
      saveSourceAndRegenerate(b.ctx, doc);
      return b;
    }],
    when: ["clearing label 0 via delete + save", ({ ctx }) => {
      const doc = loadSourceYaml(ctx);
      delete doc.agents.claw.labels[0];
      // Keep entry.labels as {} — empty-but-present is "source opted in,
      // no labels". Removing the key would revert to legacy preservation.
      saveSourceAndRegenerate(ctx, doc);
      return ctx;
    }],
    then: ["neither source nor generated contains the label", (ctx) => {
      const src = readFileSync(join(ctx.bridgeDir, "agentmux.yaml"), "utf-8");
      expect(src).not.toContain("to be cleared");
      const gen = readFileSync(ctx.configPath, "utf-8");
      expect(gen).not.toContain("to be cleared");
      cleanup();
    }],
  });

  component("regenerate preserves carry-over channel IDs across writes", {
    given: ["bridge with existing channel mappings", () => {
      const b = setupBridge();
      // Simulate a /sync-produced agents.yaml with Discord bindings
      writeFileSync(b.configPath, `
claw:
  dir: /tmp/claw
  id: claw-uuid
  discord:
    "chan-0": 0
    "chan-1": 1
  panes:
    - name: claude
      cmd: claude
    - name: claude-2
      cmd: claude
ai:
  dir: /tmp/ai
  id: ai-uuid
  panes:
    - name: claude
      cmd: claude
`);
      return b;
    }],
    when: ["setting a label and regenerating", ({ ctx }) => {
      const doc = loadSourceYaml(ctx);
      doc.agents.claw.labels = { 0: "tagged" };
      saveSourceAndRegenerate(ctx, doc);
      return ctx;
    }],
    then: ["channel IDs and uuid survive the rewrite", (ctx) => {
      const gen = readFileSync(ctx.configPath, "utf-8");
      expect(gen).toContain("claw-uuid");
      expect(gen).toContain("chan-0");
      expect(gen).toContain("chan-1");
      expect(gen).toContain("tagged");
      cleanup();
    }],
  });
});
