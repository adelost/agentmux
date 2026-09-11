import { createHash, randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

function treeDigest(root) {
  if (!existsSync(root)) return null;
  const hash = createHash("sha256");
  const visit = (relative = "") => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
      else throw new Error(`skill contains an unsupported link or special file: ${join(root, path)}`);
    }
  };
  visit();
  return hash.digest("hex");
}

function linkSkill(link, source, shared) {
  let existing;
  try { existing = lstatSync(link); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isSymbolicLink()) return false;
    const target = resolve(dirname(link), readlinkSync(link));
    if (target === shared) return true;
    if (target !== source) return false;
  }
  mkdirSync(dirname(link), { recursive: true });
  const temporary = `${link}.${randomUUID()}.tmp`;
  symlinkSync(shared, temporary);
  renameSync(temporary, link);
  return true;
}

/** WHAT: Maps packaged skills to editable host copies and migrates provider links. WHY: Separates skill edits from immutable release bytes and preserves previous copies. */
export function installReleaseSkills({ packageRoot, home }) {
  const sourceRoot = resolve(packageRoot, "skills");
  const result = { installed: [], backups: [], preserved: [] };
  if (!existsSync(sourceRoot)) return result;
  const sharedRoot = resolve(home, ".agentmux", "skills");
  mkdirSync(sharedRoot, { recursive: true });
  if (lstatSync(sharedRoot).isSymbolicLink()) throw new Error(`shared skills directory must not be a symlink: ${sharedRoot}`);
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(sourceRoot, entry.name);
    if (!existsSync(join(source, "SKILL.md"))) continue;
    const shared = join(sharedRoot, entry.name);
    if (existsSync(shared) && lstatSync(shared).isSymbolicLink()) {
      throw new Error(`shared skill must not link into another tree: ${shared}`);
    }
    if (treeDigest(source) !== treeDigest(shared)) {
      const temporary = `${shared}.${randomUUID()}.tmp`;
      cpSync(source, temporary, { recursive: true });
      if (existsSync(shared)) {
        const backupRoot = join(home, ".agentmux", "skill-backups", randomUUID());
        mkdirSync(backupRoot, { recursive: true });
        const backup = join(backupRoot, entry.name);
        renameSync(shared, backup);
        result.backups.push(backup);
      }
      renameSync(temporary, shared);
    }
    result.installed.push(shared);
    for (const provider of [".codex", ".claude"]) {
      const link = resolve(home, provider, "skills", entry.name);
      if (!linkSkill(link, source, shared)) result.preserved.push(link);
    }
  }
  return result;
}
