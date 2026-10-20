/**
 * WHAT: Finds the paths, scripts, make targets, branches and links a rule file names, and checks them against trunk.
 * WHY: Keeps dead references visible without trusting the working tree or running any project command.
 */

import { posix } from "node:path";

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console", "terminal", "shell-session"]);
const EXAMPLE_MARKER = /(?<![\w./-])(?:e\.g\.|for example|t\.ex\.|examples?\b(?!\.\w|-)|exempel\w*)/i;
const TREE_GLYPHS = /[├└│┬─┼]/;
const KNOWN_EXTENSIONS = "md mdx mjs cjs js jsx ts tsx json jsonc yml yaml toml py sh bash zsh sql html css scss svelte vue kt kts java swift cpp cc hpp h c rs go rb php txt lock ini cfg conf env gradle xml plist png jpg jpeg gif svg webp mp4 mov wav mp3 pdf csv ps1 bat".split(" ");
const EXTENSION = new RegExp(`\\.(?:${KNOWN_EXTENSIONS.join("|")})$`, "i");
const SEGMENT = "(?:\\([\\p{L}\\p{N}_-]+\\)|\\[[\\p{L}\\p{N}_.-]+\\]|[\\p{L}\\p{N}_@~+.%-]+)";
const PATH_SHAPE = new RegExp(`^(?:\\./|\\.\\./|~/|/)?(?:${SEGMENT}/)*${SEGMENT}/?$`, "u");
const TEMPLATE_MARK = /[<>*{}$]|\.\.\.|YYYY|MM-DD/;
const NOT_A_PATH = new RegExp(`${TEMPLATE_MARK.source}|[|\\\\^\`]|:\\/\\/|\\s`);
const WEB_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|dev|org|net|app|ai|se|co|me|xyz|cloud)(?:\/|$)/i;
const PRODUCT_NAME = /^(?:node|next|nuxt|vue|react|express|three|d3|chart|socket|alpine|ember|backbone|nest|deno|bun)\.(?:js|io)$/i;
const PNPM_BUILTINS = new Set("add install i update up upgrade remove rm uninstall link ln unlink import rebuild rb prune fetch publish pack outdated list ls why audit exec dlx create init store config root bin env setup doctor patch deploy approve-builds licenses self-update help".split(" "));
const YARN_BUILTINS = new Set("add install remove upgrade up workspace workspaces dlx exec init link pack publish cache config info why plugin set global bin node constraints version npm help create generate".split(" "));
const COMMAND_START = "(?:^|&&|\\|\\||;|\\||\\()\\s*(?:[$>]\\s*)?";
const SCRIPT_NAME = "([A-Za-z0-9_][\\w:.@-]*)(?![\\w:.@=/-])";
const NPM_RUN = new RegExp(`${COMMAND_START}npm\\s+run(?:-script)?\\s+${SCRIPT_NAME}`, "g");
const PNPM_RUN = new RegExp(`${COMMAND_START}pnpm\\s+(?:run\\s+)?${SCRIPT_NAME}`, "g");
const YARN_RUN = new RegExp(`${COMMAND_START}yarn\\s+(?:run\\s+)?${SCRIPT_NAME}`, "g");
const BUN_RUN = new RegExp(`${COMMAND_START}bun\\s+run\\s+${SCRIPT_NAME}`, "g");
const MAKE_TARGET = new RegExp(`${COMMAND_START}make\\s+([A-Za-z0-9_][\\w.-]*)(?![\\w=./-])`, "g");
const ORIGIN_BRANCH = /\borigin\/([A-Za-z0-9_][\w./-]*?)(?=\.{2,3}|[\s'"`),;:]|$)/g;
const BRANCH_WORD = /\b(?:branch(?:es)?|branchen|gren(?:en)?|grenar)\s*[:=]?\s*(?:named\s+|called\s+)?$/i;
const BRANCH_NAME = /^[A-Za-z0-9_][\w./-]*$/;
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g;

function codeBlocks(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (!fence) return;
    if (!open) { open = { start: index, mark: fence[1], lang: fence[2].toLowerCase() }; return; }
    if (fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && !fence[2]) {
      blocks.push({ ...open, end: index });
      open = null;
    }
  });
  if (open) blocks.push({ ...open, end: lines.length });
  return blocks.map((block) => ({
    ...block,
    scan: SHELL_LANGS.has(block.lang) && !lines.slice(block.start + 1, block.end).some((line) => TREE_GLYPHS.test(line)),
  }));
}

const exampleNear = (lines, index) => [0, 1, 2].some((back) => EXAMPLE_MARKER.test(lines[index - back] || ""));

function cleanToken(raw) {
  let token = raw.replace(/^--?[\w-]+=/, "").replace(/^["'(]+/, "").replace(/[.,;:!?'"\]}]+$/, "");
  if (token.endsWith(")") && !token.includes("(")) token = token.slice(0, -1);
  return token.replace(/#.*$/, "").replace(/:\d+(?::\d+)?(?:-\d+)?$/, "").replace(/^\.\/(?=[^.])/, "");
}

/** Returns the path this token names, or null when it is a placeholder, a URL, a word pair or not path-shaped. */
function pathOf(raw) {
  if (NOT_A_PATH.test(raw)) return null;
  const token = cleanToken(raw);
  if (!token || !PATH_SHAPE.test(token) || PRODUCT_NAME.test(token) || (!token.includes("/") && /^\.[\w-]+$/.test(token))) return null;
  if (/^@[\w.-]+\/[\w.-]+$/.test(token) || token.startsWith("@/")) return null;
  if (/^[A-Za-z]{1,3}\/[A-Za-z]{1,3}$/.test(token) || /^[\d./]+$/.test(token) || WEB_HOST.test(token)) return null;
  const last = token.replace(/\/$/, "").split("/").pop();
  if (!token.includes("/") && !(EXTENSION.test(last) && /[A-Za-z]/.test(last))) return null;
  return token;
}

function commandRefs(text, line) {
  const refs = [];
  const add = (kind, token) => { if (token && !NOT_A_PATH.test(token)) refs.push({ line, kind, token }); };
  for (const m of text.matchAll(NPM_RUN)) add("script", m[1]);
  for (const m of text.matchAll(PNPM_RUN)) if (!PNPM_BUILTINS.has(m[1])) add("script", m[1]);
  for (const m of text.matchAll(YARN_RUN)) if (!YARN_BUILTINS.has(m[1])) add("script", m[1]);
  for (const m of text.matchAll(BUN_RUN)) if (!m[1].includes(".")) add("script", m[1]);
  for (const m of text.matchAll(MAKE_TARGET)) add("target", m[1]);
  return refs;
}

function branchRefs(text, line, before) {
  const refs = [];
  for (const m of text.matchAll(ORIGIN_BRANCH)) if (m[1] !== "HEAD" && !NOT_A_PATH.test(m[1])) refs.push({ line, kind: "branch", token: m[1] });
  const named = text.trim();
  if (before !== null && BRANCH_WORD.test(before) && BRANCH_NAME.test(named) && !named.startsWith("origin/")) {
    refs.push({ line, kind: "branch", token: named });
  }
  return refs;
}

function segmentRefs(text, line, before) {
  const refs = [...commandRefs(text, line), ...branchRefs(text, line, before)];
  if (refs.some((r) => r.kind === "branch" && r.token === text.trim())) return refs;
  const words = text.trim().split(/\s+/);
  for (const word of words) {
    if (/^origin\//.test(word)) continue;
    const token = pathOf(word);
    if (token) refs.push({ line, kind: "path", token });
  }
  return refs;
}

function linkRefs(text, line) {
  const refs = [];
  for (const m of text.replace(/`[^`]*`/g, " ").matchAll(LINK)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes("{{")) continue;
    const [rawPath, ...frag] = target.split("#");
    let path = rawPath;
    try { path = decodeURIComponent(rawPath); } catch { /* keep the raw text */ }
    refs.push({ line, kind: "link", token: path, anchor: frag.length ? frag.join("#") : null });
  }
  return refs;
}

function proseSegments(text) {
  const segments = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) if (!TEMPLATE_MARK.test(m[1])) segments.push({ text: m[1], before: text.slice(0, m.index) });
  return segments;
}

function lineRefs(text, line, inBlock) {
  if (inBlock) {
    const code = text.replace(/^\s*[$>]\s*/, "").replace(/(^|\s)#.*$/, "");
    return segmentRefs(code, line, null);
  }
  const links = linkRefs(text, line);
  const refs = proseSegments(text).flatMap((s) => segmentRefs(s.text, line, s.before));
  return [...links, ...refs.filter((r) => !(r.kind === "path" && links.some((l) => l.token === r.token)))];
}

/**
 * WHAT: Extracts path, script, target, branch and link references from one rule file's text.
 * WHY: Keeps examples, placeholders and non-shell code blocks from ever reaching the existence check.
 */
export function references(text) {
  const lines = text.split(/\r?\n/);
  const blocks = codeBlocks(lines);
  const seen = new Set();
  const found = [];
  lines.forEach((raw, index) => {
    const block = blocks.find((b) => index > b.start && index < b.end);
    if (blocks.some((b) => index === b.start || index === b.end)) return;
    if ((block && !block.scan) || exampleNear(lines, index)) return;
    for (const ref of lineRefs(raw, index + 1, Boolean(block))) {
      const key = `${ref.line}|${ref.kind}|${ref.token}|${ref.anchor ?? ""}`;
      if (!seen.has(key)) { seen.add(key); found.push(ref); }
    }
  });
  return found;
}

const slugOf = (heading) => heading.trim().toLowerCase()
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/[*~]/g, "")
  .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/g, "-");

function headingAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  const lines = text.split(/\r?\n/);
  const blocks = codeBlocks(lines);
  lines.forEach((line, index) => {
    if (blocks.some((b) => index >= b.start && index <= b.end)) return;
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const slug = slugOf(heading[1]);
      const n = counts.get(slug) || 0;
      counts.set(slug, n + 1);
      anchors.add(n ? `${slug}-${n}` : slug);
    }
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) anchors.add(m[1].toLowerCase());
  });
  return anchors;
}

function makeTargets(text) {
  const targets = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^\s#=:.\t][^:=#\t]*?)\s*:(?![=:])/);
    if (m) for (const name of m[1].split(/\s+/)) if (!name.includes("%")) targets.add(name);
  }
  return targets;
}

/**
 * WHAT: Indexes one trunk tree into the lookups the existence checks need.
 * WHY: Keeps one git listing per repository behind every path, script, target, branch and anchor query.
 */
export function makeTreeFacts({ paths, gitlinks = [], read, branches = [] }) {
  const files = new Set(paths);
  const dirs = new Set();
  const suffixes = new Set();
  const addSuffixes = (path) => {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i += 1) suffixes.add(parts.slice(i).join("/"));
  };
  for (const path of paths) {
    addSuffixes(path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const dir of dirs) addSuffixes(dir);
  const branchSet = new Set(branches);
  const cache = new Map();
  const memo = (key, build) => { if (!cache.has(key)) cache.set(key, build()); return cache.get(key); };
  const matching = (pattern) => paths.filter((path) => pattern.test(path));
  return {
    has: (path) => files.has(path),
    isDir: (path) => dirs.has(path),
    suffix: (path) => suffixes.has(path),
    underGitlink: (path) => gitlinks.some((link) => path === link || path.startsWith(`${link}/`)),
    branch: (name) => branchSet.has(name),
    scripts: () => memo("scripts", () => {
      const names = new Set();
      for (const path of matching(/(?:^|\/)package\.json$/)) {
        try { for (const name of Object.keys(JSON.parse(read(path) || "{}").scripts || {})) names.add(name); } catch { /* unreadable package.json */ }
      }
      return names;
    }),
    targets: () => memo("targets", () => new Set(matching(/(?:^|\/)(?:GNUmakefile|[Mm]akefile)$|\.mk$/).flatMap((path) => [...makeTargets(read(path) || "")]))),
    anchors: (path) => memo(`anchors:${path}`, () => (files.has(path) ? headingAnchors(read(path) || "") : null)),
  };
}

function machinePath(token, ctx) {
  const absolute = token.startsWith("~/") ? posix.join(ctx.home, token.slice(2)) : token;
  const top = absolute.split("/")[1];
  if (!token.startsWith("~/") && !ctx.pathExists(`/${top}`)) return null;
  return ctx.pathExists(absolute) ? null : `\`${token}\` does not exist on this machine`;
}

function pathMessage(token, facts, ctx) {
  if (token.startsWith("~/") || token.startsWith("/")) return machinePath(token, ctx);
  const dir = posix.dirname(ctx.ruleFile);
  const candidates = [posix.normalize(token), ...(dir === "." ? [] : [posix.normalize(posix.join(dir, token))])];
  const inside = candidates.filter((c) => c !== ".." && !c.startsWith("../"));
  if (!inside.length) return null;
  const found = inside.some((c) => { const bare = c.replace(/\/$/, ""); return facts.suffix(bare) || facts.underGitlink(bare); });
  // A path the checkout's ignore rules cover is build output or local state, never on trunk.
  return found || inside.some((c) => ctx.ignored?.(c)) ? null : `\`${token}\` is not on ${ctx.trunk}`;
}

function linkMessage(ref, facts, ctx) {
  const dir = posix.dirname(ctx.ruleFile);
  const target = ref.token === "" ? ctx.ruleFile
    : ref.token.startsWith("/") ? ref.token.slice(1) : posix.normalize(posix.join(dir === "." ? "" : dir, ref.token));
  if (target === ".." || target.startsWith("../")) return null;
  const bare = target.replace(/\/$/, "");
  if (!facts.has(bare) && !facts.isDir(bare) && !facts.underGitlink(bare)) return `link \`${ref.token}\` is not on ${ctx.trunk}`;
  if (!ref.anchor || !facts.has(bare) || !/\.(?:md|markdown|mdx)$/i.test(bare)) return null;
  const anchors = facts.anchors(bare);
  return anchors && !anchors.has(ref.anchor.toLowerCase())
    ? `link anchor \`#${ref.anchor}\` is not a heading of ${bare} on ${ctx.trunk}` : null;
}

/**
 * WHAT: Checks one reference against the trunk facts and returns the finding text, or null.
 * WHY: Keeps trunk, not the working tree, as the judge so a stale checkout cannot hide a dead path.
 */
export function exists(ref, facts, ctx) {
  if (ref.kind === "path") return pathMessage(ref.token, facts, ctx);
  if (ref.kind === "script") return facts.scripts().has(ref.token) ? null : `script \`${ref.token}\` is not in any package.json on ${ctx.trunk}`;
  if (ref.kind === "target") return facts.targets().has(ref.token) ? null : `make target \`${ref.token}\` is not in any Makefile on ${ctx.trunk}`;
  if (ref.kind === "branch") return facts.branch(ref.token) ? null : `branch \`${ref.token}\` does not exist locally or on origin`;
  return linkMessage(ref, facts, ctx);
}
