// Predicts Claude Code's "Allow external CLAUDE.md file imports?" start question from the files on disk.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_DEPTH = 5;
const MAX_BYTES = 1_000_000;
const IMPORT = /(?:^|\s)@((?:[^\s\\]|\\ )+)/gu;
const CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/gu;

/** WHAT: Reads the paths a CLAUDE.md text imports with @path. WHY: Keeps code, code spans and e-mail addresses from counting as imports Claude Code never follows. */
export function claudeMdImportPaths(text) {
  const paths = [];
  for (const match of text.replace(CODE, " ").matchAll(IMPORT)) {
    const path = match[1].replace(/\\ /gu, " ").replace(/#.*$/u, "");
    if (/^[./~A-Za-z0-9_-]/u.test(path)) paths.push(path);
  }
  return paths;
}

function regularFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_BYTES ? realpathSync(path) : null;
  } catch { return null; }
}

function markdownUnder(dir, depth = 0) {
  if (depth > 3) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownUnder(path, depth + 1));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

/** The memory files Claude Code reads in one directory: CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md, AGENTS.md where its CLAUDE.md is missing, and .claude/rules. */
function memoryFilesIn(dir) {
  const claudeMd = join(dir, "CLAUDE.md"), dotClaudeMd = join(dir, ".claude", "CLAUDE.md");
  const files = [claudeMd, join(dir, "CLAUDE.local.md"), dotClaudeMd];
  if (!regularFile(claudeMd)) files.push(join(dir, "AGENTS.md"));
  if (!regularFile(dotClaudeMd)) files.push(join(dir, ".claude", "AGENTS.md"));
  files.push(...markdownUnder(join(dir, ".claude", "rules")));
  return files.filter((file) => regularFile(file));
}

// Claude Code asks "Allow external CLAUDE.md file imports?" once per project, and only when a CLAUDE.md on the way up from the
// directory imports an existing file from outside it. Seen in claude 2.1.312: asked in ai-dsl and skybar (CLAUDE.md is @AGENTS.md), in no other project.
/** WHAT: Checks the CLAUDE.md files above a directory for imports from outside it. WHY: Keeps a pane from being held for a start question unless Claude Code would really ask it. */
export function externalClaudeMdImports(cwd, { home = homedir() } = {}) {
  let root = cwd;
  try { root = realpathSync(cwd); } catch { /* a directory that is gone has no memory files either */ }
  const outside = new Map(), visited = new Set();
  const visit = (file, depth) => {
    if (depth > MAX_DEPTH) return;
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    for (const path of claudeMdImportPaths(text)) {
      const wanted = path === "~" || path.startsWith("~/") ? join(home, path.slice(2))
        : isAbsolute(path) ? path : resolve(dirname(file), path);
      const real = regularFile(wanted);
      if (!real) continue;
      if (real !== root && !real.startsWith(`${root}/`) && !outside.has(real)) outside.set(real, { path: real, from: file });
      if (!visited.has(real)) { visited.add(real); visit(real, depth + 1); }
    }
  };
  for (let dir = root; ; dir = dirname(dir)) {
    for (const file of memoryFilesIn(dir)) visit(file, 1);
    if (dir === dirname(dir)) break;
  }
  return [...outside.values()];
}
