import { feature, unit, expect } from "bdd-vitest";
import { exists, makeTreeFacts, references } from "./rules-lint-refs.mjs";

// Guards: UC-3 (a dead path is reported against trunk) and R-1 (examples and placeholders never become errors).
const TRUNK = "origin/master";
const facts = ({ paths = [], files = {}, branches = [], gitlinks = [] } = {}) =>
  makeTreeFacts({ paths, gitlinks, branches, read: (path) => files[path] ?? null });
const ctx = (extra = {}) => ({
  trunk: TRUNK, ruleFile: "AGENTS.md", home: "/home/test", pathExists: () => false, ...extra,
});
const has = (refs, wanted) => expect(refs).toContainEqual(expect.objectContaining(wanted));

const REFERENCE_TEXT = [
  "# Rules",
  "Run `npm run lint:all` and `pnpm test` before a push.",
  "Plan lives in `docs/plan.md:12` and `scripts/release.mjs`.",
  "Build with `make release`; never push to branch `preview` directly.",
  "Compare against `origin/main`.",
  "```bash",
  "pnpm install",
  "npx vitest run tests/component/parallel-pipeline.test.ts",
  "yarn build --mode=prod",
  "make check",
  "```",
  "```typescript",
  "import x from './not/a/real/path.ts'; // npm run in-code",
  "```",
].join("\n");

const SKIPPED_TEXT = [
  "Shapes: `docs/<repo>/plan.md`, `src/*.ts`, `$HOME/x.md`, `a/{b,c}.md`, `docs/...` and `~/<name>/x`.",
  "", "", "",
  "This is an example: `docs/example-only.md` and `npm run made-up`.",
  "", "", "",
  "t.ex. `docs/swedish-example.md` finns inte.",
  "", "", "",
  "Exempel: `docs/exempel.md` finns inte heller.",
  "", "", "",
  "Keep `docs/real.md`.",
].join("\n");

feature("rules lint references", () => {
  unit("finds paths, scripts, targets and branches", {
    given: ["a rule file with backtick spans and a shell block", () => REFERENCE_TEXT],
    when: ["extracting references", (text) => references(text)],
    then: ["each kind is found on its line, and shell builtins and non-shell blocks are not", (refs) => {
      has(refs, { line: 2, kind: "script", token: "lint:all" });
      has(refs, { line: 2, kind: "script", token: "test" });
      has(refs, { line: 3, kind: "path", token: "docs/plan.md" });
      has(refs, { line: 3, kind: "path", token: "scripts/release.mjs" });
      has(refs, { line: 4, kind: "target", token: "release" });
      has(refs, { line: 4, kind: "branch", token: "preview" });
      has(refs, { line: 5, kind: "branch", token: "main" });
      has(refs, { line: 8, kind: "path", token: "tests/component/parallel-pipeline.test.ts" });
      has(refs, { line: 9, kind: "script", token: "build" });
      has(refs, { line: 10, kind: "target", token: "check" });
      expect(refs.some((r) => r.kind === "path" && r.token === "origin/main")).toBe(false);
      expect(refs.some((r) => r.token === "install")).toBe(false);
      expect(refs.filter((r) => r.line === 13)).toEqual([]);
    }],
  });

  unit("skips examples and placeholders", {
    given: ["a rule file with shapes, English and Swedish example lines and one real path", () => SKIPPED_TEXT],
    when: ["extracting references", (text) => references(text)],
    then: ["only the real path is left", (refs) => {
      expect(refs.map((r) => r.token)).toEqual(["docs/real.md"]);
    }],
  });

  unit("reports a missing path on trunk", {
    given: ["a trunk where the e2e tests moved to component", () => facts({
      paths: ["tests/component/parallel-pipeline.test.ts", "package.json"],
    })],
    when: ["checking the old and the new test path", (f) => ({
      old: exists({ kind: "path", token: "tests/e2e/parallel-pipeline.test.ts", line: 273 }, f, ctx()),
      current: exists({ kind: "path", token: "tests/component/parallel-pipeline.test.ts", line: 273 }, f, ctx()),
    })],
    then: ["the old path is an error naming trunk and the new one is fine", (result) => {
      expect(result.old).toBe("`tests/e2e/parallel-pipeline.test.ts` is not on origin/master");
      expect(result.current).toBeNull();
    }],
  });

  unit("accepts a path that exists only on trunk", {
    given: ["a trunk file the working tree lacks and a working-tree file trunk lacks", () => facts({ paths: ["docs/new.md"] })],
    when: ["checking both against trunk", (f) => ({
      trunkOnly: exists({ kind: "path", token: "docs/new.md" }, f, ctx({ pathExists: () => false })),
      treeOnly: exists({ kind: "path", token: "docs/local-only.md" }, f, ctx({ pathExists: () => true })),
    })],
    then: ["trunk decides: the first exists and the second is reported", (r) => {
      expect(r.trunkOnly).toBeNull();
      expect(r.treeOnly).toBe("`docs/local-only.md` is not on origin/master");
    }],
  });

  unit("accepts a path written from a subdirectory", {
    given: ["a trunk with a nested kit directory and a rule file in .claude", () => facts({
      paths: ["tools/studio_static/kit/disclosure.js", "AGENTS.md", "docs/dir/file.md"],
    })],
    when: ["checking shorthand, bare, parent-relative and directory forms", (f) => ({
      shorthand: exists({ kind: "path", token: "kit/disclosure.js" }, f, ctx()),
      bare: exists({ kind: "path", token: "disclosure.js" }, f, ctx()),
      parent: exists({ kind: "path", token: "../AGENTS.md" }, f, ctx({ ruleFile: ".claude/CLAUDE.md" })),
      directory: exists({ kind: "path", token: "docs/dir/" }, f, ctx()),
      gone: exists({ kind: "path", token: "kit/missing.js" }, f, ctx()),
    })],
    then: ["the real files resolve and a missing one still errors", (r) => {
      expect([r.shorthand, r.bare, r.parent, r.directory]).toEqual([null, null, null, null]);
      expect(r.gone).toBe("`kit/missing.js` is not on origin/master");
    }],
  });

  unit("reports a missing npm script and make target", {
    given: ["a trunk with two package.json files and a Makefile", () => facts({
      paths: ["package.json", "web/package.json", "Makefile"],
      files: {
        "package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
        "web/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
        Makefile: "build: deps\n\t@echo build\n.PHONY: build\n",
      },
    })],
    when: ["checking scripts and targets", (f) => ({
      missingScript: exists({ kind: "script", token: "lint:all" }, f, ctx()),
      rootScript: exists({ kind: "script", token: "test" }, f, ctx()),
      nestedScript: exists({ kind: "script", token: "dev" }, f, ctx()),
      missingTarget: exists({ kind: "target", token: "deploy" }, f, ctx()),
      target: exists({ kind: "target", token: "build" }, f, ctx()),
    })],
    then: ["only the missing ones are errors", (r) => {
      expect(r.missingScript).toBe("script `lint:all` is not in any package.json on origin/master");
      expect(r.missingTarget).toBe("make target `deploy` is not in any Makefile on origin/master");
      expect([r.rootScript, r.nestedScript, r.target]).toEqual([null, null, null]);
    }],
  });

  unit("reports a link with a dead anchor", {
    given: ["a trunk with a design file that has headings", () => facts({
      paths: ["AGENTS.md", "docs/DESIGN.md"],
      files: {
        "AGENTS.md": "# Title\n\nbody\n",
        "docs/DESIGN.md": "# Design\n\n## 6. Pseudocode\n\n## Calls made by api:0\n\n## Same\n\n## Same\n",
      },
    })],
    when: ["checking links with and without anchors", (f) => {
      const link = (token, anchor) => exists({ kind: "link", token, anchor, line: 1 }, f, ctx());
      return {
        good: link("docs/DESIGN.md", "6-pseudocode"),
        punctuated: link("docs/DESIGN.md", "calls-made-by-api0"),
        duplicate: link("docs/DESIGN.md", "same-1"),
        dead: link("docs/DESIGN.md", "7-missing"),
        gone: link("docs/GONE.md", null),
        selfGood: link("", "title"),
        selfDead: link("", "nope"),
      };
    }],
    then: ["a dead anchor or file is an error and real ones are fine", (r) => {
      expect([r.good, r.punctuated, r.duplicate, r.selfGood]).toEqual([null, null, null, null]);
      expect(r.dead).toBe("link anchor `#7-missing` is not a heading of docs/DESIGN.md on origin/master");
      expect(r.gone).toBe("link `docs/GONE.md` is not on origin/master");
      expect(r.selfDead).toBe("link anchor `#nope` is not a heading of AGENTS.md on origin/master");
    }],
  });

  unit("finds markdown links and skips web links, code spans and fenced blocks", {
    given: ["a rule file with real, web and quoted links", () => [
      "See [design](docs/DESIGN.md#6-pseudocode) and [site](https://example.com/a/b.md) and [self](#title).",
      "Quoted: `[code](docs/not-a-link.md)`.",
      "```",
      "[fenced](docs/fenced.md)",
      "```",
    ].join("\n")],
    when: ["extracting references", (text) => references(text)],
    then: ["only the two relative links are found, and the quoted one is not read as a path either", (refs) => {
      expect(refs.filter((r) => r.kind === "link").map((r) => [r.token, r.anchor])).toEqual([
        ["docs/DESIGN.md", "6-pseudocode"], ["", "title"],
      ]);
      expect(refs.filter((r) => r.kind === "path" && r.line === 2)).toEqual([]);
    }],
  });
});
