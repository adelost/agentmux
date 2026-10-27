import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const inside = (path, root) => path === root || path.startsWith(`${root}${sep}`);
const indexes = ["MEMORY.md", "USER.md", "SOUL.md", "people.md"];
const identity = stat => Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));

/** WHAT: Checks a controller-owned file path before any write. WHY: Prevents a memory link or linked parent from redirecting controller authority. */
export function assertDreamWritePath(path) {
  let cursor = resolve(path), file = true;
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error(`dream-controller-path-not-isolated:${cursor}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent; file = false;
  }
}

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
      entries[path] = path === artifactRoot && skip.size > 0
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

/** WHAT: Returns every changed path in two memory observations. WHY: Keeps missing, restored and newly created files inside the same effect check. */
export function changedDreamMemory(before, after) {
  return [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])]
    .filter(path => JSON.stringify(before.entries[path]) !== JSON.stringify(after.entries[path]));
}
