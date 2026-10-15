import { chmodSync, lstatSync, linkSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** WHAT: Defines the materialization marker name. WHY: Keeps old symlink and copy layouts distinguishable from shared inodes. */
export const MATERIALIZATION_MARKER = ".agentmux-worktree-links.json";
const VERSION = 2;

/** WHAT: Visits dependency entries without following links. WHY: Executable links must remain local and cache sealing must not escape the tree. */
function visit(root, fn, relative = "") {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    fn(path, lstatSync(join(root, path)));
    if (entry.isDirectory()) visit(root, fn, path);
  }
}

/** WHAT: Applies read-only permissions to shared files. WHY: Prevents accidental in-place edits from modifying every consumer. */
export function sealNodeCache(modules) {
  visit(modules, (path, stat) => {
    if (stat.isFile() && (stat.mode & 0o222)) chmodSync(join(modules, path), stat.mode & ~0o222);
  });
}

/** WHAT: Checks every shared inode and permission. WHY: Prevents a marker alone from admitting writable or duplicated files. */
export function nodeMaterializationReady(path, cacheModules, key) {
  try {
    const marker = JSON.parse(readFileSync(join(path, MATERIALIZATION_MARKER), "utf8"));
    if (lstatSync(path).isSymbolicLink() || marker.version !== VERSION
      || marker.input.cacheModules !== cacheModules || marker.input.key !== key) return false;
    let ready = true;
    visit(cacheModules, (name, cached) => {
      const local = lstatSync(join(path, name));
      if (cached.isFile()) ready &&= local.isFile() && local.dev === cached.dev
        && local.ino === cached.ino && !(cached.mode & 0o222);
      else if (cached.isDirectory()) ready &&= local.isDirectory() && !local.isSymbolicLink();
      else if (cached.isSymbolicLink()) ready &&= local.isSymbolicLink()
        && readlinkSync(join(path, name)) === readlinkSync(join(cacheModules, name));
      else ready = false;
    });
    return ready;
  } catch { return false; }
}

/** WHAT: Builds real directories with immutable hardlinked files. WHY: Keeps Vite realpaths local without silently allocating a full ext4 copy. */
export function createNodeMaterialization(path, cacheModules, key) {
  sealNodeCache(cacheModules);
  const staging = join(dirname(path), `.amux-node-${randomUUID()}`);
  mkdirSync(staging);
  try {
    visit(cacheModules, (name, stat) => {
      const source = join(cacheModules, name); const target = join(staging, name);
      if (stat.isDirectory()) mkdirSync(target);
      else if (stat.isFile()) linkSync(source, target);
      else if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
      else throw new Error(`unsupported dependency entry: ${source}`);
    });
    writeFileSync(join(staging, MATERIALIZATION_MARKER), `${JSON.stringify(
      { version: VERSION, input: { cacheModules, key } }, null, 2)}\n`);
    rmSync(path, { recursive: true, force: true });
    renameSync(staging, path);
  } catch (error) {
    if (error.code === "EXDEV") error.message = `hardlink dependencies require cache and worktree on the same filesystem: ${error.message}`;
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
