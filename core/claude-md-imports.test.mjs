import { expect, feature, unit } from "bdd-vitest";
import { afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeMdImportPaths, externalClaudeMdImports } from "./claude-md-imports.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A temp tree from {relative path: text}; returns its real root. */
function tree(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "amux-imports-")));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const paneDir = root => join(root, ".agents/0");
const pathsOf = found => found.map(item => item.path);

// 3 Nov 2026: claude 2.1.312 asked "Allow external CLAUDE.md file imports?" in ai-dsl and skybar, whose CLAUDE.md is "@AGENTS.md",
// and in no other of the eight projects. The scanner has to say the same for the same trees.
feature("the CLAUDE.md imports that make Claude Code ask before it starts", () => {
  unit("a CLAUDE.md above the pane directory that imports a sibling file is one outside import", {
    given: ["a project whose CLAUDE.md is @AGENTS.md", () => tree({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# rules\n" })],
    when: ["scanning its pane directory", root => ({ root, found: externalClaudeMdImports(paneDir(root)) })],
    then: ["the sibling file is named with the file that imports it", ({ root, found }) => {
      expect(found).toEqual([{ path: join(root, "AGENTS.md"), from: join(root, "CLAUDE.md") }]);
    }],
  });

  unit("an import of a file that does not exist asks nothing", {
    given: ["a CLAUDE.md that points at a missing file", () => tree({ "CLAUDE.md": "@missing.md\n" })],
    when: ["scanning its pane directory", root => externalClaudeMdImports(paneDir(root))],
    then: ["there is nothing to approve", found => { expect(found).toEqual([]); }],
  });

  unit("an import of a file inside the pane directory asks nothing", {
    given: ["a pane directory whose own CLAUDE.md imports a file beside it", () =>
      tree({ ".agents/0/CLAUDE.md": "@./notes.md\n", ".agents/0/notes.md": "notes\n" })],
    when: ["scanning it", root => externalClaudeMdImports(paneDir(root))],
    then: ["it stays inside the directory", found => { expect(found).toEqual([]); }],
  });

  unit("code, fenced blocks and e-mail addresses are not imports", {
    given: ["a CLAUDE.md that mentions @AGENTS.md only as code or inside an address", () => tree({
      "CLAUDE.md": "Use `@AGENTS.md` for rules.\n```\n@AGENTS.md\n```\nWrite to me@AGENTS.md or ask.\n",
      "AGENTS.md": "# rules\n",
    })],
    when: ["scanning its pane directory", root => externalClaudeMdImports(paneDir(root))],
    then: ["nothing is imported", found => { expect(found).toEqual([]); }],
  });

  unit("imports inside imported files count, and a cycle ends", {
    given: ["CLAUDE.md imports one.md, which imports two.md, which imports one.md again", () => tree({
      "CLAUDE.md": "@one.md\n", "one.md": "@two.md\n", "two.md": "@one.md\n" })],
    when: ["scanning its pane directory", root => ({ root, found: externalClaudeMdImports(paneDir(root)) })],
    then: ["both files are named once", ({ root, found }) => {
      expect(pathsOf(found).sort()).toEqual([join(root, "one.md"), join(root, "two.md")]);
    }],
  });

  unit("~/ is the home directory", {
    given: ["a CLAUDE.md that imports @~/shared.md from a given home", () => ({
      project: tree({ "CLAUDE.md": "@~/shared.md\n" }), home: tree({ "shared.md": "shared\n" }) })],
    when: ["scanning with that home", ({ project, home }) => ({ home, found: externalClaudeMdImports(paneDir(project), { home }) })],
    then: ["the file under home is the import", ({ home, found }) => { expect(pathsOf(found)).toEqual([join(home, "shared.md")]); }],
  });

  unit("AGENTS.md is read only where the directory has no CLAUDE.md", {
    given: ["one directory with both files and one with AGENTS.md alone, each importing x.md", () => ({
      both: tree({ "CLAUDE.md": "plain\n", "AGENTS.md": "@x.md\n", "x.md": "x\n" }),
      alone: tree({ "AGENTS.md": "@x.md\n", "x.md": "x\n" }) })],
    when: ["scanning both", ({ both, alone }) => ({ both: externalClaudeMdImports(paneDir(both)), alone: externalClaudeMdImports(paneDir(alone)) })],
    then: ["only the AGENTS.md without a CLAUDE.md beside it counts", ({ both, alone }) => {
      expect(both).toEqual([]);
      expect(alone).toHaveLength(1);
    }],
  });

  unit("a rules file is a memory file", {
    given: ["a .claude/rules file that imports x.md", () => tree({ ".claude/rules/a.md": "@../../x.md\n", "x.md": "x\n" })],
    when: ["scanning the pane directory", root => ({ root, found: externalClaudeMdImports(paneDir(root)) })],
    then: ["x.md is outside the pane directory", ({ root, found }) => { expect(pathsOf(found)).toEqual([join(root, "x.md")]); }],
  });

  unit("a directory that is gone has no imports", {
    when: ["scanning a path that does not exist", () => externalClaudeMdImports("/amux-no-such-dir/.agents/0")],
    then: ["the answer is an empty list", found => { expect(found).toEqual([]); }],
  });

  unit("the import syntax drops fragments, keeps escaped spaces and ignores words that are not paths", {
    when: ["reading a text with each form", () => claudeMdImportPaths("see @docs/a.md#top and @my\\ file.md and @!bad and user@x.com and @@twice")],
    then: ["only the two paths remain", paths => { expect(paths).toEqual(["docs/a.md", "my file.md"]); }],
  });
});
