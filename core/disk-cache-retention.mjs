import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  opendirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { processPathReferences } from "./process-path-references.mjs";

const DAY = 86400000;
const KEY = /^[a-f0-9]{32}$/u;
const REPOSITORY_KEY = /^[a-f0-9]{16}$/u;
const GRADLE_PROCESS = /(?:GradleDaemon|GradleWrapperMain|GradleMain|gradle-launcher|KotlinCompileDaemon|(?:^|[\s/])gradlew?(?:\s|$))/u;

// Use is the newest mtime or ctime: materializing a checkout hardlinks the files, which sets ctime.
// Access time is no evidence: on 2026-10-22 scans had read a file in all 239 entries within the hour.
// O_NOATIME and directory descriptors still keep the inspection itself from touching the tree.
const INSPECT_ENTRY = String.raw`
import hashlib, json, os, stat, sys, time
request = json.load(sys.stdin)
root = request["path"]
limit = request["maxFiles"]
deadline = time.monotonic() + request["timeoutMs"] / 1000
count, newest, size, freeable = 0, 0, 0, 0
digest = hashlib.sha256()

def observed(path):
    global count, newest, size, freeable
    count += 1
    if count > limit or time.monotonic() > deadline:
        raise ValueError("entry inspection budget exceeded")
    item = os.lstat(path)
    newest = max(newest, item.st_mtime_ns, item.st_ctime_ns)
    digest.update(json.dumps([os.path.relpath(path, root), item.st_dev, item.st_ino,
        item.st_mode, item.st_size, item.st_mtime_ns, item.st_ctime_ns]).encode())
    if stat.S_ISREG(item.st_mode):
        size += item.st_blocks * 512
        if item.st_nlink == 1:
            freeable += item.st_blocks * 512
    return item

def names(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NOATIME)
    try:
        with os.scandir(fd) as items:
            result = []
            for item in items:
                result.append(item.name)
                if len(result) > limit:
                    raise ValueError("directory inspection budget exceeded")
            return sorted(result)
    finally:
        os.close(fd)

def document(path, max_bytes):
    item = os.lstat(path)
    if not stat.S_ISREG(item.st_mode) or item.st_size > max_bytes:
        raise ValueError("invalid or oversized metadata")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NOATIME)
    with os.fdopen(fd, encoding="utf8") as stream:
        return json.load(stream)

def walk(path, depth=0):
    if depth > 64:
        raise ValueError("entry nesting budget exceeded")
    item = observed(path)
    if stat.S_ISDIR(item.st_mode):
        for name in names(path):
            walk(os.path.join(path, name), depth + 1)
    elif not stat.S_ISREG(item.st_mode) and not stat.S_ISLNK(item.st_mode):
        raise ValueError("unsupported dependency entry")

try:
    if os.path.realpath(root) != root or not stat.S_ISDIR(observed(root).st_mode):
        raise ValueError("noncanonical or linked entry")
    if names(root) != ["manifest.json", "node_modules"]:
        raise ValueError("partial or unrecognized cache entry")
    marker = document(os.path.join(root, "manifest.json"), 1048576)
    inputs = marker.get("input", {})
    key = inputs.get("key")
    source = {k: v for k, v in inputs.items() if k != "key"}
    expected = hashlib.sha256(json.dumps(source, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()[:32]
    if marker.get("version") != 1 or key != os.path.basename(root) or key != expected:
        raise ValueError("invalid cache manifest identity")
    for field in ["packageHash", "lockHash"]:
        value = inputs.get(field, "")
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("invalid cache manifest hash")
    relative = inputs.get("repoRelativeRoot", "")
    if not relative or os.path.isabs(relative) or ".." in relative.split("/"):
        raise ValueError("invalid source root metadata")
    modules = os.path.join(root, "node_modules")
    if not stat.S_ISDIR(os.lstat(modules).st_mode):
        raise ValueError("linked or missing node_modules")
    installed = document(os.path.join(modules, ".package-lock.json"), 16777216)
    packages = installed.get("packages")
    if not isinstance(packages, dict) or not packages or len(packages) > limit:
        raise ValueError("partial installed dependency metadata")
    for package, record in packages.items():
        if not package.startswith("node_modules/") or ".." in package.split("/"):
            raise ValueError("invalid installed dependency path")
        # npm records optional packages for other platforms (fsevents, sharp-darwin) as ideallyInert and never installs them.
        if isinstance(record, dict) and record.get("ideallyInert") is True:
            continue
        target = os.path.join(root, package)
        if os.path.realpath(target) != target or not stat.S_ISDIR(os.lstat(target).st_mode):
            raise ValueError("missing or linked installed dependency")
    observed(os.path.join(root, "manifest.json"))
    walk(modules)
    print(json.dumps({"path": root, "newestUseMs": newest / 1000000,
        "bytes": size, "freeableBytes": freeable, "identity": digest.hexdigest(), "files": count}))
except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
    print(json.dumps({"path": root, "reason": str(error)}))
`;

/** WHAT: Checks canonical directories without following a linked boundary. WHY: Prevents cache collection from escaping explicit repository roots. */
function canonicalDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error(`noncanonical or linked directory: ${path}`);
  }
}

/** WHAT: Reads directory names within an explicit count budget. WHY: Prevents unrelated or malformed cache trees from exhausting guard memory. */
function boundedNames(path, limit) {
  const directory = opendirSync(path), names = [];
  try {
    for (let item; (item = directory.readSync());) {
      if (names.length >= limit) throw new Error(`directory entry budget exceeded: ${path}`);
      names.push(item.name);
    }
  } finally { directory.closeSync(); }
  return names;
}

/** WHAT: Checks complete process-reference response shapes. WHY: Prevents absent or unreadable holder evidence from authorizing deletion. */
function referenceEvidence(targets, references) {
  if (!targets.length) return { holders: {}, errors: [] };
  try {
    const result = references(targets);
    if (!Array.isArray(result?.errors) || targets.some((path) => !Array.isArray(result.holders?.[path]))) {
      throw new Error("incomplete process-reference response");
    }
    return result;
  } catch (error) { return { holders: {}, errors: [{ error: error.message }] }; }
}

/** WHAT: Collects recognized entries in one node directory. WHY: Keeps partial staging names out of retirement. */
function nodeEntries(node, maxEntries, entries, skipped) {
  try { canonicalDirectory(node); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of boundedNames(node, maxEntries)) {
    const path = join(node, name);
    if (!KEY.test(name)) { skipped.push({ path, reasons: ["partial or unrecognized cache name"] }); continue; }
    if (entries.length >= maxEntries) throw new Error("dependency entry budget exceeded");
    entries.push(path);
  }
}

/** WHAT: Collects entries in a store laid out as <repository key>/node/<entry key>, or node/<entry key> in the oldest in-.git stores. WHY: Lets every store generation use one recognizer. */
function storeEntries(cache, maxEntries, entries, skipped) {
  try { canonicalDirectory(cache); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of boundedNames(cache, maxEntries)) {
    if (name === "node") { nodeEntries(join(cache, name), maxEntries, entries, skipped); continue; }
    if (!REPOSITORY_KEY.test(name)) continue;
    canonicalDirectory(join(cache, name));
    nodeEntries(join(cache, name, "node"), maxEntries, entries, skipped);
  }
}

/** WHAT: Collects recognized cache paths below explicit repositories and stores. WHY: Keeps worktree copies, source and partial staging directories outside retirement. */
export function dependencyCacheEntries(repositoryRoots, { maxRepositories = 128, maxEntries = 1024, storeRoots = [] } = {}) {
  const entries = [], skipped = [], errors = [];
  if (!Number.isSafeInteger(maxRepositories) || maxRepositories < 1 || maxRepositories > 128
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000
    || !Array.isArray(repositoryRoots) || repositoryRoots.length > maxRepositories) {
    return { entries, skipped, errors: [{ error: "explicit repository root budget exceeded or missing" }] };
  }
  for (const root of [...new Set(repositoryRoots)]) {
    try {
      if (!isAbsolute(root)) throw new Error("repository root must be absolute");
      canonicalDirectory(root); canonicalDirectory(join(root, ".git"));
      storeEntries(join(root, ".agentmux-worktree-deps"), maxEntries, entries, skipped);
    } catch (error) { errors.push({ path: root, error: error.message }); }
  }
  for (const store of [...new Set(storeRoots)]) {
    try {
      if (!isAbsolute(store)) throw new Error("store root must be absolute");
      storeEntries(store, maxEntries, entries, skipped);
    } catch (error) { errors.push({ path: store, error: error.message }); }
  }
  return { entries, skipped, errors };
}

/** WHAT: Reads bounded dependency usage metadata without touching the tree. WHY: Keeps the inspection from becoming the change it measures. */
export function inspectDependencyCacheEntry(path, { maxFiles = 150000, timeoutMs = 15000 } = {}) {
  try {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 150000
      || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("invalid inspection budget");
    return JSON.parse(execFileSync("/usr/bin/python3", ["-c", INSPECT_ENTRY], {
      input: JSON.stringify({ path, maxFiles, timeoutMs }), encoding: "utf8", timeout: timeoutMs + 1000,
      maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) { return { path, reason: `entry inspection failed: ${error.message}` }; }
}

// Checkouts made before hardlink materialization (July 2026) read the store through symlinks.
// Noninteractive sudo reads folders whose mode hides them from the user.
/** WHAT: Collects cache entries that a checkout's node_modules symlinks into. WHY: Prevents retirement from breaking a checkout that reads its entry through a symlink. */
export function dependencySymlinkConsumers(entries, { searchRoots = [join(homedir(), "lsrc")], maxDepth = 8,
  listLinks = (root) => execFileSync(process.getuid?.() === 0 ? "/usr/bin/find" : "sudo", [
    ...(process.getuid?.() === 0 ? [] : ["-n", "/usr/bin/find"]), root, "-xdev", "-maxdepth", String(maxDepth), "(", "-name", ".git",
    "-o", "-path", "*/node_modules/[!@]*/*", "-o", "-path", "*/node_modules/@*/*/*", ")", "-prune", "-o", "-type", "l",
    "-printf", "%h\\t%l\\n"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 900000, stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  const linked = new Set(), errors = [], byPath = new Set(entries);
  for (const root of searchRoots) {
    let output;
    try { output = listLinks(root); }
    catch (error) { errors.push({ path: root, error: `symlink scan failed: ${(error.stderr?.toString().trim() || error.message).split("\n")[0]}` }); continue; }
    for (const line of output.split("\n")) {
      const [directory, target] = line.split("\t");
      if (!target) continue;
      let cursor = resolve(directory, target);
      while (cursor !== dirname(cursor)) {
        if (byPath.has(cursor)) { linked.add(cursor); break; }
        cursor = dirname(cursor);
      }
    }
  }
  return { linked, errors };
}

/** WHAT: Checks one cache's inactivity and process evidence. WHY: Keeps recent, corrupt or live dependency inodes out of cleanup. */
export function dependencyCacheRetirementDecision({ entry, nowMs = Date.now(), unusedDays = 7, holders = [], errors = [], linked = false }) {
  const reasons = [];
  if (linked) reasons.push("symlinked by a checkout's node_modules");
  if (errors.length) reasons.push("unreadable process or filesystem evidence");
  if (entry?.reason) reasons.push(entry.reason);
  if (!entry?.identity || !Number.isFinite(entry?.bytes) || entry.bytes < 0
    || !Number.isFinite(entry?.newestUseMs)) reasons.push("incomplete entry metadata");
  if (!Number.isFinite(unusedDays) || unusedDays < 7 || !Number.isFinite(nowMs)
    || nowMs - entry?.newestUseMs < unusedDays * DAY) reasons.push("cache used or changed within retention period");
  if (holders.length) reasons.push("process cwd, fd or mapping inside");
  return { ok: reasons.length === 0, reasons };
}

/** WHAT: Collects dependency entries admitted by every retention check. WHY: Separates reviewable retirement plans from filesystem mutations. */
export function planDependencyCacheRetirement({ repositoryRoots, nowMs = Date.now(), unusedDays = 7,
  references = processPathReferences, inspectEntry = inspectDependencyCacheEntry,
  consumers = dependencySymlinkConsumers, ...limits } = {}) {
  const collected = dependencyCacheEntries(repositoryRoots, limits);
  const candidates = [], skipped = [...collected.skipped];
  const safety = referenceEvidence(collected.entries, references), links = consumers(collected.entries);
  const errors = [...collected.errors, ...(safety.errors || []), ...links.errors];
  for (const path of collected.entries) {
    const entry = inspectEntry(path);
    const verdict = dependencyCacheRetirementDecision({ entry, nowMs, unusedDays, errors, linked: links.linked.has(path),
      holders: safety.holders?.[path] || [] });
    if (verdict.ok) candidates.push(entry);
    else skipped.push({ path, reasons: verdict.reasons });
  }
  return { candidates, skipped, errors };
}

/** WHAT: Reads root-disk usage in bytes. WHY: Keeps action receipts tied to actual free-space changes. */
export function sampleRootDisk() {
  const row = execFileSync("df", ["-kP", "/"], { encoding: "utf8", timeout: 10000 }).trim().split("\n").at(-1).trim().split(/\s+/u);
  const sample = { totalBytes: Number(row[1]) * 1024, usedBytes: Number(row[2]) * 1024, availableBytes: Number(row[3]) * 1024 };
  if (!Object.values(sample).every(Number.isFinite)) throw new Error("unreadable root df counters");
  return sample;
}

/** WHAT: Stores and syncs one cache action receipt. WHY: Preserves before-and-after disk evidence if the guard exits. */
function appendJournal(path, entry) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try { appendFileSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** WHAT: Dispatches one measured unlink after a durable attempt receipt. WHY: Keeps read-only shared inodes intact for surviving hardlinked consumers. */
function removeMeasured(entry, { kind, remove, sampleDisk, journal, nowMs }) {
  const record = { at: new Date(nowMs).toISOString(), kind, path: entry.path, estimatedBytes: entry.bytes,
    before: sampleDisk(), mode: "attempting" };
  journal({ ...record });
  try { remove(entry.path); record.mode = "removed"; }
  catch (error) { record.mode = "refused"; record.error = error.message; }
  try { record.after = sampleDisk(); record.freedBytes = record.after.availableBytes - record.before.availableBytes; }
  catch (error) { record.measurementError = error.message; }
  journal({ ...record });
  return record;
}

/** WHAT: Dispatches dependency retirement after fresh usage and process checks. WHY: Prevents plans from authorizing deletion after a cache becomes active. */
export function applyDependencyCacheRetention({ dryRun = true, nowMs = Date.now(), unusedDays = 7,
  references = processPathReferences, inspectEntry = inspectDependencyCacheEntry,
  remove = (path) => rmSync(path, { recursive: true }), sampleDisk = sampleRootDisk,
  journal = (entry) => appendJournal(join(homedir(), ".agentmux", "disk-retention-actions.jsonl"), entry), ...options } = {}) {
  const plan = planDependencyCacheRetirement({ ...options, nowMs, unusedDays, references, inspectEntry });
  const actions = [];
  if (dryRun) return { ...plan, actions, dryRun };
  for (const entry of plan.candidates) {
    const fresh = inspectEntry(entry.path), safety = referenceEvidence([entry.path], references);
    const verdict = dependencyCacheRetirementDecision({ entry: fresh, nowMs, unusedDays,
      holders: safety.holders?.[entry.path] || [], errors: safety.errors || [] });
    if (!verdict.ok || fresh.identity !== entry.identity) {
      plan.skipped.push({ path: entry.path, reasons: [...verdict.reasons, ...(fresh.identity !== entry.identity ? ["entry changed after planning"] : [])] });
      continue;
    }
    actions.push(removeMeasured(fresh, { kind: "dependency-cache", remove, sampleDisk, journal, nowMs }));
  }
  return { ...plan, actions, dryRun };
}

/** WHAT: Reads running Gradle and Kotlin process evidence. WHY: Keeps all build-cache actions idle-only without stopping any process. */
function readBuildProcesses() {
  return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
}

/** WHAT: Reads regular-file usage and inode identity. WHY: Keeps symlinks and changing Gradle entries outside unlink decisions. */
function inspectGradleFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular Gradle cache file");
  return { path, bytes: stat.blocks * 512, newestUseMs: Math.max(stat.atimeMs, stat.mtimeMs, stat.ctimeMs),
    identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") };
}

/** WHAT: Collects bounded Gradle build-cache files and old-log candidates. WHY: Preserves version caches, downloaded modules and unrecognized files. */
function gradleEntries(gradleHome, maxEntries) {
  const build = [], logs = [], errors = []; let totalBytes = 0, count = 0;
  const list = (path) => {
    try { canonicalDirectory(path); return boundedNames(path, maxEntries); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const file = (path) => { if (++count > maxEntries) throw new Error("Gradle entry budget exceeded"); return inspectGradleFile(path); };
  try {
    canonicalDirectory(gradleHome);
    canonicalDirectory(join(gradleHome, "caches"));
    for (const name of list(join(gradleHome, "caches", "build-cache-1"))) {
      const path = join(gradleHome, "caches", "build-cache-1", name);
      const entry = file(path); totalBytes += entry.bytes;
      if (KEY.test(name)) build.push({ ...entry, kind: "gradle-build-cache" });
    }
    for (const version of list(join(gradleHome, "daemon"))) {
      if (!/^\d+(?:\.\d+)+(?:[-.][a-zA-Z0-9.-]+)?$/u.test(version)) continue;
      for (const name of list(join(gradleHome, "daemon", version))) {
        if (/^daemon-\d+\.out\.log$/u.test(name)) logs.push({ ...file(join(gradleHome, "daemon", version, name)), kind: "gradle-daemon-log" });
      }
    }
  } catch (error) { errors.push({ path: gradleHome, error: error.message }); }
  return { build, logs, errors, totalBytes };
}

/** WHAT: Checks idle Gradle processes and complete path-reference evidence. WHY: Refuses cleanup whenever a build or unreadable process could hold the cache. */
function gradleSafety(targets, listProcesses, references) {
  try {
    const processes = String(listProcesses()).split("\n").filter((line) => GRADLE_PROCESS.test(line));
    const safety = referenceEvidence(targets, references);
    return { ...safety, processes, errors: [...(safety.errors || []), ...(processes.length ? [{ error: "Gradle or Kotlin process exists" }] : [])] };
  } catch (error) { return { holders: {}, processes: [], errors: [{ error: error.message }] }; }
}

/** WHAT: Collects idle Gradle unlinks toward the build-cache byte ceiling. WHY: Keeps the approximate cap separate from Gradle's age-only native settings. */
export function planGradleCacheRetention({ gradleHome = join(homedir(), ".gradle"), nowMs = Date.now(),
  maxBuildCacheBytes = 10 * 1024 ** 3, maxEntries = 100000, listProcesses = readBuildProcesses,
  references = processPathReferences } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000
    || !Number.isFinite(nowMs) || !Number.isFinite(maxBuildCacheBytes) || maxBuildCacheBytes < 0) {
    return { candidates: [], skipped: [], errors: [{ error: "invalid Gradle retention budget" }],
      buildCacheBytes: null, projectedBuildCacheBytes: null, capSatisfied: false, projectedCapSatisfied: false };
  }
  const collected = gradleEntries(gradleHome, maxEntries), candidates = [], skipped = [];
  const targets = [join(gradleHome, "caches", "build-cache-1"), join(gradleHome, "daemon")];
  const safety = gradleSafety(targets, listProcesses, references);
  const errors = [...collected.errors, ...safety.errors];
  if (targets.some((path) => safety.holders?.[path]?.length)) errors.push({ error: "process holds Gradle cache or daemon path" });
  let projectedBytes = collected.totalBytes;
  if (!errors.length) {
    for (const entry of collected.build.sort((a, b) => a.newestUseMs - b.newestUseMs)) {
      if (projectedBytes <= maxBuildCacheBytes) break;
      candidates.push(entry); projectedBytes -= entry.bytes;
    }
    for (const entry of collected.logs) {
      if (nowMs - entry.newestUseMs > 12 * 60 * 60 * 1000) candidates.push(entry);
      else skipped.push({ path: entry.path, reasons: ["daemon log used or changed within 12 hours"] });
    }
  }
  return { candidates, skipped, errors, buildCacheBytes: collected.totalBytes, projectedBuildCacheBytes: projectedBytes,
    capSatisfied: !errors.length && collected.totalBytes <= maxBuildCacheBytes,
    projectedCapSatisfied: !errors.length && projectedBytes <= maxBuildCacheBytes };
}

/** WHAT: Dispatches Gradle unlinks after fresh idle and inode checks. WHY: Preserves live builds and records actual disk relief for every action. */
export function applyGradleCacheRetention({ dryRun = true, nowMs = Date.now(), gradleHome = join(homedir(), ".gradle"),
  listProcesses = readBuildProcesses, references = processPathReferences, remove = (path) => rmSync(path),
  sampleDisk = sampleRootDisk,
  journal = (entry) => appendJournal(join(homedir(), ".agentmux", "disk-retention-actions.jsonl"), entry), ...options } = {}) {
  const plan = planGradleCacheRetention({ ...options, gradleHome, nowMs, listProcesses, references }), actions = [];
  if (dryRun || plan.errors.length) return { ...plan, actions, dryRun };
  for (const entry of plan.candidates) {
    const safety = gradleSafety([gradleHome, entry.path], listProcesses, references);
    if (safety.errors.length || Object.values(safety.holders || {}).some((holders) => holders.length)) {
      plan.errors.push(...safety.errors, { path: entry.path, error: "fresh process evidence refused Gradle cleanup" }); break;
    }
    try {
      const fresh = inspectGradleFile(entry.path);
      if (fresh.identity !== entry.identity || fresh.newestUseMs !== entry.newestUseMs) {
        plan.skipped.push({ path: entry.path, reasons: ["Gradle entry changed after planning"] }); continue;
      }
      actions.push(removeMeasured(fresh, { kind: entry.kind, remove, sampleDisk, journal, nowMs }));
    } catch (error) { plan.errors.push({ path: entry.path, error: error.message }); }
  }
  const after = gradleEntries(gradleHome, options.maxEntries ?? 100000);
  return { ...plan, actions, dryRun, errors: [...plan.errors, ...after.errors], buildCacheBytesAfter: after.totalBytes,
    capSatisfied: !plan.errors.length && !after.errors.length && after.totalBytes <= (options.maxBuildCacheBytes ?? 10 * 1024 ** 3) };
}
