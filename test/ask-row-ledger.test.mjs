import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { dispatch } from "../cli/commands.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ask-row-source-"));
  const saved = { AMUX_AGENT_NAME: process.env.AMUX_AGENT_NAME, AMUX_PANE: process.env.AMUX_PANE, AMUX_ASK_BINDINGS_PATH: process.env.AMUX_ASK_BINDINGS_PATH };
  Object.assign(process.env, { AMUX_AGENT_NAME: "test", AMUX_PANE: "0", AMUX_ASK_BINDINGS_PATH: join(root, "bindings.jsonl") });
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]);
  mkdirSync(join(root, "projects/haunt-ux-2026-10-18"), { recursive: true });
  const ledger = "projects/haunt-ux-2026-10-18/TASKS.md";
  writeFileSync(join(root, ledger), "| # | Outcome |\n| --- | --- |\n| 264 | Synthetic task |\n");
  git(["add", ledger]); git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "synthetic ledger"]);
  const configPath = join(root, "agents.yaml"), sourcesPath = join(root, "ledger-sources.json");
  writeFileSync(configPath, `test:\n  dir: ${root}\n  panes:\n    - cmd: codex\n`);
  const sources = [{ root: "/unrelated", ref: "refs/heads/master", path: "wrong.md" }, { root, ref: "refs/heads/master", path: ledger, name: "Huset" }];
  writeFileSync(sourcesPath, JSON.stringify(sources));
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { root, ledger, saved, sources, sourcesPath, git, path: process.env.AMUX_ASK_BINDINGS_PATH,
    ctx: { configPath, cwd: root, ledgerSourcesPath: sourcesPath, readAskLedger: () => [{ id: "synthetic" }] } };
}
function cleanup(fx) {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(fx.saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(fx.root, { recursive: true, force: true });
}

feature("row binding uses the configured ledger source", () => {
  component("a bare repository reads its configured ledger from HEAD", {
    given: ["the same committed ledger in a bare clone", () => {
      const fx = fixture(), bare = join(fx.root, "bare.git");
      execFileSync("git", ["clone", "--bare", "--quiet", fx.root, bare], { stdio: "pipe" });
      writeFileSync(fx.sourcesPath, JSON.stringify([{ root: bare, ref: "refs/heads/master", path: fx.ledger }]));
      fx.ctx.cwd = bare; fx.expected = `${bare}/${fx.ledger}:264`; return fx;
    }],
    when: ["binding row264 through the same command", async fx => { await dispatch(["asks", "bind", "synthetic", "--row", "264"], fx.ctx); return fx; }],
    then: ["the configured bare ledger is the exact target", fx => expect(JSON.parse(readFileSync(fx.path, "utf8")).ref).toBe(fx.expected)], cleanup,
  });
  component("an invalid configured path fails before a binding is written", {
    given: ["a source path outside the repository", () => {
      const fx = fixture(); writeFileSync(fx.sourcesPath, JSON.stringify([{ root: fx.root, path: "../TASKS.md" }])); return fx;
    }],
    when: ["binding through the invalid mapping", async fx => { await expect(dispatch(["asks", "bind", "synthetic", "--row", "264"], fx.ctx)).rejects.toThrow("Invalid configured task ledger path"); return fx; }],
    then: ["nothing was appended", fx => expect(existsSync(fx.path)).toBe(false)], cleanup,
  });
  component("Huset row264 binds from the repository root without docs/TASKS.md", {
    given: ["the same root/path source shape used by stats", fixture],
    when: ["binding the exact id through the CLI dispatcher", async fx => { await dispatch(["asks", "bind", "synthetic", "--row", "264"], fx.ctx); return fx; }],
    then: ["the stored reference names Huset's actual ledger", fx => {
      expect(JSON.parse(readFileSync(fx.path, "utf8")).ref).toBe(`${fx.root}/${fx.ledger}:264`);
    }], cleanup,
  });
  component("a missing configured row does not fall through to another ledger", {
    given: ["a configured ledger without row265 and a default with that row", () => {
      const fx = fixture(); mkdirSync(join(fx.root, "docs")); writeFileSync(join(fx.root, "docs/TASKS.md"), "| 265 | wrong ledger |\n"); return fx;
    }],
    when: ["binding row265", async fx => {
      await expect(dispatch(["asks", "bind", "synthetic", "--row", "265"], fx.ctx)).rejects.toThrow(`Task row 265 does not exist in ${fx.root}/${fx.ledger}`); return fx;
    }],
    then: ["nothing was appended", fx => expect(existsSync(fx.path)).toBe(false)], cleanup,
  });
  for (const absent of ["source", "file", "path"]) component(`docs/TASKS.md remains the fallback with no configured ${absent}`, {
    given: ["a default ledger and absent optional mapping", () => {
      const fx = fixture(); mkdirSync(join(fx.root, "docs")); writeFileSync(join(fx.root, "docs/TASKS.md"), "| 71 | Synthetic task |\n");
      if (absent === "file") rmSync(fx.sourcesPath);
      else writeFileSync(fx.sourcesPath, JSON.stringify(absent === "source" ? [fx.sources[0]] : [{ root: fx.root, ref: "refs/heads/master" }]));
      return fx;
    }],
    when: ["binding a default row", async fx => { await dispatch(["asks", "bind", "synthetic", "--row", "71"], fx.ctx); return fx; }],
    then: ["the reference uses the default path", fx => expect(JSON.parse(readFileSync(fx.path, "utf8")).ref).toBe(`${fx.root}/docs/TASKS.md:71`)], cleanup,
  });
});
