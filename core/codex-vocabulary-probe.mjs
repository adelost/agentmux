// Verifies the pinned Codex composer vocabulary against the Codex binary
// that panes actually run. The strings themselves live in
// codex-vocabulary.mjs; this module owns PATH, package and file I/O.

import {
  closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  CODEX_VOCABULARY, codexVocabularyStrings, describeCodexVocabularyDrift,
} from "./codex-vocabulary.mjs";

const CHUNK_BYTES = 8 * 1024 * 1024;

/** WHAT: Resolves the `codex` launcher from PATH. WHY: Keeps the probe on the binary panes run, not the one npm lists. */
export function locateCodexLauncher({ env = process.env } = {}) {
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// @openai/codex ships the native TUI in a platform package beside the JS
// launcher: node_modules/@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex.
function findNativeBinary(packageRoot) {
  const scope = join(packageRoot, "node_modules", "@openai");
  let packages;
  try { packages = readdirSync(scope).filter((name) => name.startsWith("codex-")); }
  catch { return null; }
  for (const name of packages) {
    const vendor = join(scope, name, "vendor");
    let triples;
    try { triples = readdirSync(vendor); } catch { continue; }
    for (const triple of triples) {
      for (const file of ["codex", "codex.exe"]) {
        const candidate = join(vendor, triple, "bin", file);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** WHAT: Resolves the installed @openai/codex version and native binary. WHY: Keeps discovery tied to the launcher panes execute. */
export function locateInstalledCodex({ env = process.env } = {}) {
  const launcher = locateCodexLauncher({ env });
  if (!launcher) return { error: "codex is not on PATH" };
  let launcherReal;
  try { launcherReal = realpathSync(launcher); }
  catch (error) { return { error: `codex launcher unreadable: ${error.message}` }; }
  const packageRoot = resolve(dirname(launcherReal), "..");
  let version;
  try { version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version; }
  catch (error) { return { error: `codex package.json unreadable at ${packageRoot}: ${error.message}` }; }
  if (typeof version !== "string" || !version) return { error: `codex package.json at ${packageRoot} has no version` };
  const binaryPath = findNativeBinary(packageRoot);
  if (!binaryPath) return { error: `no native codex binary under ${packageRoot}` };
  return { launcher: launcherReal, packageRoot, version, binaryPath };
}

/** WHAT: Reports which needles occur in a file. WHY: Keeps a 250 MB binary scan from loading the file into memory. */
export function scanFileForStrings(path, needles) {
  const pending = new Map(needles.map((needle) => [needle, Buffer.from(needle, "utf8")]));
  const found = [];
  const overlap = Math.max(0, ...[...pending.values()].map((bytes) => bytes.length - 1));
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES + overlap);
    let carry = 0;
    let position = 0;
    while (pending.size > 0) {
      const read = readSync(fd, chunk, carry, CHUNK_BYTES, position);
      if (read === 0) break;
      position += read;
      const window = chunk.subarray(0, carry + read);
      for (const [needle, bytes] of pending) {
        if (window.indexOf(bytes) === -1) continue;
        found.push(needle);
        pending.delete(needle);
      }
      carry = Math.min(overlap, window.length);
      window.copy(chunk, 0, window.length - carry);
    }
  } finally {
    closeSync(fd);
  }
  return { found, missing: [...pending.keys()] };
}

function fileIdentity(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    return `${path}:${stat.size}:${stat.mtimeMs}`;
  } finally {
    closeSync(fd);
  }
}

let memo = null;

// Returns raw facts, never a verdict: `installedVersion`, `verifiedVersion`,
// `checked`, `missing` — or `error` when no binary could be located. The
// scan is memoised per binary identity (path, size, mtime) so the bridge
// pays the 250 MB read once per Codex install, not per failed delivery.
/** WHAT: Compares the pinned vocabulary with the installed Codex binary. WHY: Keeps a Codex upgrade from passing as a human draft unnoticed. */
export function probeCodexVocabulary({
  vocabulary = CODEX_VOCABULARY,
  locate = locateInstalledCodex,
  scan = scanFileForStrings,
  identity = fileIdentity,
  cache = true,
} = {}) {
  const verifiedVersion = vocabulary.verifiedCodexVersion;
  const installed = locate();
  if (installed.error) {
    return { error: installed.error, installedVersion: null, verifiedVersion, checked: 0, missing: [] };
  }
  let key;
  try { key = identity(installed.binaryPath); }
  catch (error) {
    return { error: `codex binary unreadable: ${error.message}`, installedVersion: installed.version, verifiedVersion, checked: 0, missing: [] };
  }
  if (cache && memo?.key === key) return memo.result;
  const strings = codexVocabularyStrings(vocabulary);
  const { missing } = scan(installed.binaryPath, strings);
  const result = {
    installedVersion: installed.version,
    verifiedVersion,
    binaryPath: installed.binaryPath,
    checked: strings.length,
    missing,
  };
  if (cache) memo = { key, result };
  return result;
}

/** WHAT: Describes vocabulary drift for the installed Codex. WHY: Keeps delivery errors from blaming a human for a new placeholder. */
export async function codexVocabularyDrift() {
  return describeCodexVocabularyDrift(probeCodexVocabulary());
}
