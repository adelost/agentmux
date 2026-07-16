/**
 * WHAT: Enforces changed-file selection, prose style, and monotonic source-size caps.
 * WHY: Keeps repository ratchets separate from symbol contract extraction.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import yaml from "js-yaml";

const DEFAULT_MAX_SOURCE_LINES = 500;
const EM_DASH = String.fromCodePoint(0x2014);
const STYLE_SUGGESTIONS = {
  STYLE001: "replace the em dash in user text with a comma, colon, semicolon, or period",
  STYLE002: "replace the spaced prose hyphen with punctuation",
  STYLE010: "split the file, or lower an existing legacy cap as logic moves out",
  STYLE011: "restore the trunk cap; per-file caps may only decrease",
  STYLE012: "set each legacy cap to the file's exact current line count",
  STYLE013: "use positive integer caps under fileSize.caps with repo-relative paths",
  STYLE014: "restore the trunk lint policy; legacy cap history cannot be reset",
};

function emptyLintPolicy(configPath, defaultWhatVerbs) {
  return {
    allowedWhatVerbs: defaultWhatVerbs,
    configPath,
    fileCaps: {},
    configFindings: [],
  };
}

function configFinding(path, msg) {
  return {
    code: "STYLE013",
    sev: "error",
    msg,
    path,
    line: 1,
    suggestion: STYLE_SUGGESTIONS.STYLE013,
  };
}

function validCapPath(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return normalized
    && !isAbsolute(normalized)
    && normalized !== ".."
    && !normalized.startsWith("../")
    && !normalized.includes("/../");
}

function parseLintPolicy(source, path, defaultWhatVerbs) {
  const policy = emptyLintPolicy(path, defaultWhatVerbs);
  let doc;
  try {
    doc = yaml.load(source) || {};
  } catch (error) {
    policy.configFindings.push(configFinding(path, `invalid YAML: ${error.message}`));
    return policy;
  }
  const verbs = doc?.contract?.allowedWhatVerbs;
  policy.allowedWhatVerbs = Array.isArray(verbs)
    ? [...new Set([...defaultWhatVerbs, ...verbs.map(String).filter(Boolean)])]
    : defaultWhatVerbs;

  const caps = doc?.fileSize?.caps;
  if (caps === undefined) return policy;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    policy.configFindings.push(configFinding(path, "fileSize.caps must be a path-to-integer mapping"));
    return policy;
  }
  for (const [rawPath, rawCap] of Object.entries(caps)) {
    const capPath = String(rawPath).replaceAll("\\", "/");
    const cap = Number(rawCap);
    if (!validCapPath(capPath) || !Number.isSafeInteger(cap) || cap < 1) {
      policy.configFindings.push(configFinding(path, `invalid file-size cap ${rawPath}: ${rawCap}`));
      continue;
    }
    policy.fileCaps[capPath] = cap;
  }
  return policy;
}

function findLintConfigPath(root) {
  let dir = root;
  try {
    if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
  } catch {}
  let previous = "";
  while (dir && dir !== previous) {
    for (const name of [".amux-lint.yml", ".amux-lint.yaml"]) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    previous = dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * WHAT: Loads repo-local contract verbs and exact legacy source-size caps.
 * WHY: Keeps policy exceptions reviewable in the repository that owns them.
 */
export function loadLintPolicy(root, defaultWhatVerbs) {
  const configPath = findLintConfigPath(resolve(root));
  return configPath
    ? parseLintPolicy(readFileSync(configPath, "utf-8"), configPath, defaultWhatVerbs)
    : emptyLintPolicy(null, defaultWhatVerbs);
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitContext(root, options = {}) {
  const resolvedRoot = resolve(root);
  let start = resolvedRoot;
  try {
    if (existsSync(start) && statSync(start).isFile()) start = dirname(start);
  } catch {}
  const repoRootRaw = gitOutput(start, ["rev-parse", "--show-toplevel"]);
  if (!repoRootRaw) return null;
  const repoRoot = resolve(repoRootRaw);
  const explicit = options.baseRef
    || process.env.AMUX_LINT_BASE_REF
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null);
  if (explicit) {
    if (!gitOutput(repoRoot, ["rev-parse", "--verify", `${explicit}^{commit}`])) {
      throw new Error(`amux lint: base ref '${explicit}' is unavailable; changed-file lint refuses to guess`);
    }
    return { repoRoot, baseRef: explicit };
  }
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (gitOutput(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`])) {
      return { repoRoot, baseRef: candidate };
    }
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("amux lint: CI did not provide a resolvable trunk ref");
  }
  return { repoRoot, baseRef: null };
}

function outputPaths(repoRoot, output) {
  return (output || "").split(/\r?\n/).filter(Boolean).map((path) => resolve(repoRoot, path));
}

/**
 * WHAT: Collects committed and local paths changed relative to one trunk revision.
 * WHY: Prevents clean CI worktrees from turning changed-file lint into a zero-file pass.
 */
export function changedSourcePaths(root, options = {}) {
  const context = gitContext(root, options);
  if (!context) return new Set();
  const resolvedRoot = resolve(root);
  const pathspec = relative(context.repoRoot, resolvedRoot).replaceAll("\\", "/") || ".";
  const outputs = [];
  if (context.baseRef) {
    const committed = gitOutput(context.repoRoot, [
      "diff", "--name-only", "--diff-filter=ACMRTUXB", `${context.baseRef}...HEAD`, "--", pathspec,
    ]);
    if (committed === null) {
      throw new Error(`amux lint: could not compare HEAD with trunk ref '${context.baseRef}'`);
    }
    outputs.push(committed);
  }
  for (const args of [
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--", pathspec],
    ["ls-files", "--others", "--exclude-standard", "--", pathspec],
  ]) {
    const output = gitOutput(context.repoRoot, args);
    if (output === null) throw new Error("amux lint: could not enumerate local changed files");
    outputs.push(output);
  }
  return new Set(outputs.flatMap((output) => outputPaths(context.repoRoot, output)));
}

function extractStringLiterals(source, ext) {
  const python = ext === ".py";
  const literals = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (python && char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (!python && char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (!python && char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += source[index] === "*" ? 2 : 0;
      continue;
    }
    if (!python && char === "/" && regexCanStart(source, index)) {
      index = skipRegexLiteral(source, index);
      continue;
    }
    if (char !== "\"" && char !== "'" && (python || char !== "`")) {
      index += 1;
      continue;
    }

    const triple = python && source.slice(index, index + 3) === char.repeat(3);
    const delimiter = triple ? char.repeat(3) : char;
    const startLine = line;
    let value = "";
    index += delimiter.length;
    while (index < source.length) {
      if (source.slice(index, index + delimiter.length) === delimiter) {
        index += delimiter.length;
        break;
      }
      if (source[index] === "\\") {
        value += source[index];
        index += 1;
        if (index < source.length) {
          if (source[index] === "\n") line += 1;
          value += source[index];
          index += 1;
        }
        continue;
      }
      if (source[index] === "\n") {
        line += 1;
        if (!triple && delimiter !== "`") break;
      }
      value += source[index];
      index += 1;
    }
    literals.push({ value, line: startLine, delimiter });
  }
  return literals;
}

function regexCanStart(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /[ \t\r\n]/.test(source[previous])) previous -= 1;
  if (previous < 0 || /[=(:,!&|?{};\[\]]/.test(source[previous])) return true;
  const lineStart = source.lastIndexOf("\n", index) + 1;
  return /(?:\breturn|\bthrow|\bcase|=>)\s*$/.test(source.slice(lineStart, index));
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let characterClass = false;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "[") characterClass = true;
    else if (source[index] === "]") characterClass = false;
    else if (source[index] === "/" && !characterClass) {
      index += 1;
      while (/[a-z]/i.test(source[index] || "")) index += 1;
      return index;
    } else if (source[index] === "\n") {
      return index;
    }
    index += 1;
  }
  return index;
}

function literalLine(literal, offset) {
  return literal.line + literal.value.slice(0, offset).split("\n").length - 1;
}

function spacedProseHyphen(value) {
  for (const match of value.matchAll(/[ \t]+-[ \t]+/g)) {
    const offset = match.index || 0;
    const lineStart = value.lastIndexOf("\n", offset) + 1;
    const lineEndRaw = value.indexOf("\n", offset);
    const lineEnd = lineEndRaw < 0 ? value.length : lineEndRaw;
    const left = value.slice(lineStart, offset);
    const right = value.slice(offset + match[0].length, lineEnd);
    if (/\p{L}{2,}/u.test(left) && /\p{L}{2,}/u.test(right)) return offset;
  }
  return -1;
}

/**
 * WHAT: Reports banned dash punctuation inside source string literals.
 * WHY: Keeps user-facing prose consistent without flagging examples in comments.
 */
export function lintStringStyle(path, source, ext) {
  const findings = [];
  for (const literal of extractStringLiterals(source, ext)) {
    const styleValue = literal.delimiter === "`"
      ? literal.value.replace(/\$\{[^}]*\}/gs, (expression) => expression.replace(/[^\n]/g, " "))
      : literal.value;
    const emDash = styleValue.indexOf(EM_DASH);
    if (emDash >= 0) {
      findings.push({
        code: "STYLE001",
        sev: "error",
        msg: "user-facing string contains an em dash",
        path,
        line: literalLine(literal, emDash),
        suggestion: STYLE_SUGGESTIONS.STYLE001,
      });
    }
    const spacedHyphen = spacedProseHyphen(styleValue);
    if (spacedHyphen >= 0) {
      findings.push({
        code: "STYLE002",
        sev: "error",
        msg: "prose string uses a spaced hyphen as punctuation",
        path,
        line: literalLine(literal, spacedHyphen),
        suggestion: STYLE_SUGGESTIONS.STYLE002,
      });
    }
  }
  return findings;
}

function sourceLineCount(source) {
  if (!source) return 0;
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function configCapLine(policy, capPath) {
  if (!policy.configPath) return 1;
  const lines = readFileSync(policy.configPath, "utf-8").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(capPath));
  return index < 0 ? 1 : index + 1;
}

function readBasePolicy(root, policy, options = {}) {
  const context = gitContext(root, options);
  if (!context?.baseRef) return null;
  const configDir = policy.configPath
    ? relative(context.repoRoot, dirname(policy.configPath)).replaceAll("\\", "/")
    : "";
  for (const name of [".amux-lint.yml", ".amux-lint.yaml"]) {
    const configRel = configDir ? `${configDir}/${name}` : name;
    const source = gitOutput(context.repoRoot, ["show", `${context.baseRef}:${configRel}`]);
    if (source !== null) return parseLintPolicy(source, resolve(context.repoRoot, configRel), []);
  }
  return null;
}

function sizeFinding(code, msg, path, line) {
  return { code, sev: "error", msg, path, line, suggestion: STYLE_SUGGESTIONS[code] };
}

/**
 * WHAT: Reports changed files over their cap and every cap increase from trunk.
 * WHY: Prevents legacy exceptions from becoming permanent growth budgets.
 */
export function lintFileSizes(root, files, policy, options = {}) {
  const findings = [...policy.configFindings];
  const capRoot = policy.configPath ? dirname(policy.configPath) : root;
  for (const file of files) {
    const capPath = relative(capRoot, file).replaceAll("\\", "/");
    const cap = policy.fileCaps[capPath] || DEFAULT_MAX_SOURCE_LINES;
    const lines = sourceLineCount(readFileSync(file, "utf-8"));
    if (lines > cap) {
      findings.push(sizeFinding("STYLE010", `${capPath} is ${lines} lines; cap is ${cap}`, file, cap + 1));
    }
  }

  if (policy.configPath) {
    for (const [capPath, cap] of Object.entries(policy.fileCaps)) {
      const file = resolve(capRoot, capPath);
      if (!existsSync(file) || !statSync(file).isFile()) {
        findings.push(sizeFinding("STYLE012", `${capPath} has a cap but is not a file`,
          policy.configPath, configCapLine(policy, capPath)));
        continue;
      }
      const lines = sourceLineCount(readFileSync(file, "utf-8"));
      if (cap > lines) {
        findings.push(sizeFinding("STYLE012", `${capPath} cap ${cap} exceeds its current ${lines} lines`,
          policy.configPath, configCapLine(policy, capPath)));
      }
    }
  }

  const basePolicy = readBasePolicy(root, policy, options);
  if (basePolicy) {
    if (!policy.configPath && Object.keys(basePolicy.fileCaps).length > 0) {
      findings.push(sizeFinding("STYLE014", "trunk file-size caps were removed",
        basePolicy.configPath, 1));
      return findings;
    }
    for (const [capPath, cap] of Object.entries(policy.fileCaps)) {
      const baseCap = basePolicy.fileCaps[capPath] || DEFAULT_MAX_SOURCE_LINES;
      if (cap > baseCap) {
        findings.push(sizeFinding("STYLE011", `${capPath} cap increased from ${baseCap} to ${cap}`,
          policy.configPath, configCapLine(policy, capPath)));
      }
    }
  }
  return findings;
}
