import { execFileSync } from "node:child_process";

// One pass per tree: inodes count once, and only single-link files count as
// freeable, because removing a hardlinked file frees nothing while another
// link survives. ctime counts as a change, matching worktree retirement.
// Chromium's cookie and login stores mark a browser profile, which cleanup never touches.
const MEASURE_TREES = String.raw`
import json, os, stat, sys
PROFILE_FILES = {"Cookies", "Login Data", "Web Data"}
request = json.load(sys.stdin)
result = {}
for root in request["paths"]:
    seen, total, unique, files, newest, modified, profile = set(), 0, 0, 0, 0, 0, False
    try:
        item = os.lstat(root)
        if not stat.S_ISDIR(item.st_mode):
            raise ValueError("not a directory")
        newest, modified = max(item.st_mtime_ns, item.st_ctime_ns), item.st_mtime_ns
        pending = [root]
        while pending:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    try:
                        item = entry.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    newest = max(newest, item.st_mtime_ns, item.st_ctime_ns)
                    modified = max(modified, item.st_mtime_ns)
                    if stat.S_ISDIR(item.st_mode):
                        pending.append(entry.path)
                    elif stat.S_ISREG(item.st_mode):
                        files += 1
                        profile = profile or entry.name in PROFILE_FILES
                        if (item.st_dev, item.st_ino) in seen:
                            continue
                        seen.add((item.st_dev, item.st_ino))
                        total += item.st_blocks * 512
                        if item.st_nlink == 1:
                            unique += item.st_blocks * 512
        result[root] = {"bytes": total, "freeableBytes": unique, "files": files, "newestChangeMs": newest / 1000000,
            "newestModifiedMs": modified / 1000000, "browserProfile": profile}
    except (OSError, ValueError) as error:
        result[root] = {"error": str(error)}
print(json.dumps(result))
`;

/** WHAT: Reads size, freeable size and newest change for each tree. WHY: Keeps dry-run numbers honest about hardlinks and keeps age checks on the whole tree, not its top folder. */
export function measureTrees(paths, { timeoutMs = 1800000 } = {}) {
  if (!paths.length) return {};
  return JSON.parse(execFileSync("/usr/bin/python3", ["-c", MEASURE_TREES], {
    input: JSON.stringify({ paths }), encoding: "utf8", timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }));
}
