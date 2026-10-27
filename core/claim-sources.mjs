import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

const git = (dir, args) => {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trimEnd() : null;
};
const expand = path => path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;

/** WHAT: Resolves citations against recorded remote-default tips. WHY: Prevents local-only and stale checkout bytes from establishing current code evidence. */
export function createClaimSources(paths = []) {
  const repos = [...new Set(paths.map(p => typeof p === "string" ? p : p.dir).filter(Boolean))].flatMap(dir => {
    const root = git(expand(dir), ["rev-parse", "--show-toplevel"]);
    if (!root) return [];
    const branch = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"])
      || ["refs/remotes/origin/master", "refs/remotes/origin/main"].find(ref => git(root, ["rev-parse", "--verify", ref]));
    const tip = branch && git(root, ["rev-parse", "--verify", `${branch}^{commit}`]);
    return tip ? [{ dir: root, ref: branch, tip }] : [];
  });
  const cache = new Map();
  function fileAtTip(path) {
    path = expand(path);
    const candidates = repos.flatMap(repo => {
      const rel = isAbsolute(path) ? relative(repo.dir, path) : path.replace(/^\.\//u, "");
      if (rel.startsWith("../") || isAbsolute(rel)) return [];
      const bytes = git(repo.dir, ["show", `${repo.tip}:${rel}`]);
      return bytes === null ? [] : [{ ...repo, path: rel, bytes }];
    });
    if (candidates.length) return candidates;
    // Absolute paths inside a repository must never fall through to its local working copy.
    if (!isAbsolute(path) || repos.some(repo => !relative(repo.dir, path).startsWith("../"))) return [];
    try { return statSync(path).isFile() ? [{ path, bytes: readFileSync(path, "utf8") }] : []; }
    catch { return []; }
  }
  return {
    repos: repos.map(({ dir, ref, tip }) => ({ dir, ref, tip })),
    validate(source) {
      const key = JSON.stringify(source);
      if (cache.has(key)) return cache.get(key);
      let valid = false;
      if (source.kind === "sha") valid = repos.some(repo => git(repo.dir, ["rev-parse", "--verify", `${source.value}^{commit}`]));
      else if (source.kind === "path") valid = fileAtTip(source.value).some(file => !source.line
        || (source.line > 0 && source.line <= file.bytes.split("\n").length));
      else valid = ["url", "delivery", "command"].includes(source.kind);
      cache.set(key, Boolean(valid));
      return Boolean(valid);
    },
  };
}
