import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (path, root) => path === root || path.startsWith(`${root}${sep}`);
const indexes = ["MEMORY.md", "USER.md", "SOUL.md", "people.md"];
const identity = stat => Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));

/** WHAT: Reads one bounded ordinary file without following its final link. WHY: Prevents a result or manifest from aliasing protected memory. */
export function readDreamRegular(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error("dream-file-not-isolated");
    const bytes = readFileSync(fd);
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(fstatSync(fd, { bigint: true })))) throw new Error("dream-file-changed-during-read");
    return bytes;
  } finally { closeSync(fd); }
}

/** WHAT: Defines memory from the workspace and configured pane roots. WHY: Prevents curator text from choosing a smaller protected scope. */
export function dreamMemoryRoots(workspace, paneDirs = []) {
  const bases = new Set([resolve(workspace), ...paneDirs.map(path => resolve(path))]);
  // Private workspace memory is protected even for panes omitted from tonight's source batch.
  try {
    for (const entry of readdirSync(join(workspace, ".agents"), { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) bases.add(join(resolve(workspace), ".agents", entry.name));
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return [...bases].flatMap(base => [join(base, "memory"), ...indexes.map(name => join(base, name))]).sort();
}

/** WHAT: Reads bytes, identities, additions, removals and link targets. WHY: Keeps dynamic arguments and restored bytes from concealing memory effects. */
export function snapshotDreamMemory(roots, { artifactRoot, ignored = [] } = {}) {
  const scope = [...new Set(roots.map(path => resolve(path)))].sort();
  const skip = new Set(ignored.map(path => resolve(path))), entries = {}, visited = new Set();
  let files = 0, totalBytes = 0;
  const visit = path => {
    if (skip.has(path) || visited.has(path)) return;
    visited.add(path);
    if (++files > 20000) throw new Error("dream-memory-snapshot-file-limit");
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") { entries[path] = { kind: "missing" }; return; } throw error; }
    const id = identity(stat);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!scope.some(root => inside(target, root))) throw new Error(`dream-memory-link-outside-scope:${path}`);
      entries[path] = { kind: "link", ...id, target: readlinkSync(path) };
      visit(target);
    } else if (stat.isDirectory()) {
      // The one permitted output may change its parent directory's timestamps and size.
      entries[path] = path === artifactRoot
        ? { kind: "directory", dev: id.dev, ino: id.ino, mode: id.mode }
        : { kind: "directory", ...id };
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      totalBytes += Number(stat.size);
      if (totalBytes > 512 * 1024 * 1024 || stat.size > 256n * 1024n * 1024n) throw new Error("dream-memory-snapshot-byte-limit");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (JSON.stringify(identity(fstatSync(fd, { bigint: true }))) !== JSON.stringify(id)) throw new Error("dream-memory-snapshot-race");
        const hasher = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
        let count, bytes = 0;
        while ((count = readSync(fd, buffer)) > 0) {
          bytes += count;
          if (bytes > Number(stat.size)) throw new Error("dream-memory-snapshot-race");
          hasher.update(buffer.subarray(0, count));
        }
        const sha256 = hasher.digest("hex");
        if (JSON.stringify(identity(fstatSync(fd, { bigint: true }))) !== JSON.stringify(id)) throw new Error("dream-memory-snapshot-race");
        entries[path] = { kind: "file", ...id, sha256 };
      } finally { closeSync(fd); }
    } else throw new Error(`dream-memory-snapshot-special-file:${path}`);
  };
  scope.forEach(visit);
  if (artifactRoot) visit(artifactRoot);
  return { version: 1, roots: scope, entries };
}

const pathsFor = inputPath => ({ input: inputPath, manifest: inputPath.replace(/\.json$/u, ".memory-before.json"), output: inputPath.replace(/\.json$/u, ".summary.md") });

/** WHAT: Stores the controller's pre-curation snapshot. WHY: Prevents recovery from manufacturing a historical baseline or changing its scope. */
export function prepareDreamMemoryEffects({ workspace, paneDirs = [], inputPath }) {
  const paths = pathsFor(resolve(inputPath)), artifactRoot = dirname(paths.input);
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(artifactRoot).isSymbolicLink() || realpathSync(artifactRoot) !== artifactRoot) throw new Error("dream-artifact-directory-link");
  for (const path of Object.values(paths)) {
    try { lstatSync(path); throw new Error("dream-run-artifact-already-exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const roots = dreamMemoryRoots(workspace, paneDirs);
  if (roots.some(root => inside(artifactRoot, root) || inside(root, artifactRoot))) throw new Error("dream-artifact-memory-overlap");
  const before = snapshotDreamMemory(roots, { artifactRoot, ignored: Object.values(paths) });
  const bytes = Buffer.from(`${JSON.stringify(before)}\n`);
  const fd = openSync(paths.manifest, "wx", 0o400);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(artifactRoot, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return { version: 1, sha256: digest(bytes) };
}

/** WHAT: Checks every protected effect before the controller writes. WHY: Prevents script syntax, legacy fallbacks or result links from granting memory-write authority. */
export function verifyDreamMemoryEffects({ inputPath, inputSha256, descriptor, workspace, paneDirs = [] }) {
  if (descriptor?.version !== 1 || !/^[a-f0-9]{64}$/u.test(descriptor.sha256 || "")) throw new Error("dream-memory-effects-unattested");
  const paths = pathsFor(resolve(inputPath)), artifactRoot = dirname(paths.input);
  if (realpathSync(artifactRoot) !== artifactRoot) throw new Error("dream-artifact-directory-link");
  if (digest(readDreamRegular(paths.input, 256 * 1024)) !== inputSha256) throw new Error("dream-input-changed");
  const bytes = readDreamRegular(paths.manifest, 16 * 1024 * 1024);
  if (digest(bytes) !== descriptor.sha256) throw new Error("dream-memory-manifest-changed");
  const before = JSON.parse(bytes);
  if (before.version !== 1 || !Array.isArray(before.roots) || !before.entries
      || dreamMemoryRoots(workspace, paneDirs).some(root => !before.roots.includes(root))) throw new Error("dream-memory-scope-changed");
  const after = snapshotDreamMemory(before.roots, { artifactRoot, ignored: Object.values(paths) });
  const changed = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])]
    .filter(path => JSON.stringify(before.entries[path]) !== JSON.stringify(after.entries[path]));
  if (changed.length) throw new Error(`dream-curator-touched-memory:${changed.slice(0, 3).join(",")}`);
  readDreamRegular(paths.output, 48 * 1024);
  return { version: 1, files: Object.keys(after.entries).length, sha256: descriptor.sha256 };
}
