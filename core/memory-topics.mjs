import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { decideMemoryTopic } from "../policies/memory-topics.mjs";

/** WHAT: Defines the topic byte budget. WHY: Keeps summaries bounded before parsing and retrieval. */
export const TOPIC_MAX_BYTES = 8_000;
const SOURCE_MAX_BYTES = 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,79}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const STATUSES = ["ACTIVE", "SUPERSEDED", "CONFLICT"];
const fields = new Set(["version", "id", "title", "summary", "asOf", "status", "aliases", "sources"]);

/** WHAT: Returns the hash of exact persisted bytes. WHY: Keeps a topic bound to the source version actually reviewed. */
export const topicHash = bytes => createHash("sha256").update(bytes).digest("hex");

/** WHAT: Resolves the private topic directory. WHY: Keeps derived summaries separate from original memory. */
export const topicDirectory = workspace => join(resolve(workspace), "memory", "topics");

/** WHAT: Reads a bounded stable regular file. WHY: Prevents symlinks, oversized input and concurrent changes from crossing the file boundary. */
export function readTopicFile(path, maxBytes = TOPIC_MAX_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error(`expected regular file <= ${maxBytes} bytes`);
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const length = readSync(fd, buffer, count, buffer.length - count, count);
      if (!length) break;
      count += length;
    }
    const bytes = buffer.subarray(0, count);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error("file changed during read");
    return bytes;
  } finally { closeSync(fd); }
}

function parseDocument(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if (!match) throw new Error("expected YAML frontmatter followed by Markdown");
  const meta = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  const body = match[2].trim();
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("frontmatter must be a mapping");
  if (Object.keys(meta).some(key => !fields.has(key))) throw new Error("unknown frontmatter field");
  if (meta.version !== 1 || !ID.test(meta.id || "") || !STATUSES.includes(meta.status)) throw new Error("invalid version, id or status");
  for (const name of ["title", "summary"]) {
    if (typeof meta[name] !== "string" || !meta[name].trim() || meta[name].length > 240 || /[\r\n]/u.test(meta[name])) throw new Error(`invalid ${name}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(meta.asOf || "") || !Number.isFinite(Date.parse(meta.asOf))
    || new Date(meta.asOf).toISOString().slice(0, 10) !== meta.asOf) throw new Error("asOf must be an ISO date");
  if (!Array.isArray(meta.aliases) || meta.aliases.length > 32
    || meta.aliases.some(value => typeof value !== "string" || value.length > 160)) throw new Error("aliases must contain at most 32 short strings");
  if (!Array.isArray(meta.sources) || !meta.sources.length || meta.sources.length > 8) throw new Error("expected 1 to 8 sources");
  if (!body || text.split(/\r?\n/u).length > 120 || Buffer.byteLength(text) > TOPIC_MAX_BYTES) throw new Error("topic exceeds 120 lines/8000 bytes or has no body");
  for (const source of meta.sources) {
    if (!source || typeof source.path !== "string" || isAbsolute(source.path) || source.path.includes("\\")
      || source.path.split("/").some(part => ["..", ".", ""].includes(part)) || !SHA.test(source.sha256 || "")
      || !Number.isSafeInteger(source.from) || !Number.isSafeInteger(source.to) || source.from < 1 || source.to < source.from
      || Object.keys(source).some(key => !["path", "sha256", "from", "to"].includes(key))) throw new Error("invalid source path/hash/line range");
  }
  return { meta, body };
}

function observeSource(workspace, source, cache) {
  const path = resolve(workspace, source.path);
  try {
    const root = realpathSync(workspace);
    const actual = realpathSync(path);
    const rel = relative(root, actual);
    if (rel.startsWith("..") || isAbsolute(rel) || actual === root
      || actual.startsWith(`${realpathSync(join(root, "memory"))}/topics/`)) throw new Error("source must be original material inside this workspace");
    if (!cache.has(actual)) cache.set(actual, readTopicFile(actual, SOURCE_MAX_BYTES));
    const bytes = cache.get(actual);
    if (source.to > bytes.toString("utf8").split(/\r?\n/u).length) return { ...source, path, state: "UNAVAILABLE", reason: "source line range no longer exists" };
    const observedSha256 = topicHash(bytes);
    return { ...source, path, observedSha256, state: observedSha256 === source.sha256 ? "MATCH" : "CHANGED" };
  } catch (error) { return { ...source, path, state: "UNAVAILABLE", reason: error.code || error.message }; }
}

/** WHAT: Checks one candidate against its original source files. WHY: Keeps stale evidence and malformed summaries outside the serving boundary. */
export function inspectTopic(workspace, path, { text, cache = new Map() } = {}) {
  let meta;
  try {
    const content = text ?? readTopicFile(path).toString("utf8");
    const parsed = parseDocument(content);
    meta = parsed.meta;
    if (basename(path) !== `${meta.id}.md`) throw new Error("filename must match topic id");
    const sources = meta.sources.map(source => observeSource(workspace, source, cache));
    const source = sources.some(row => row.state === "UNAVAILABLE") ? "UNAVAILABLE"
      : sources.some(row => row.state === "CHANGED") ? "CHANGED" : "MATCH";
    const facts = { shape: "VALID", status: meta.status, source };
    const decision = decideMemoryTopic(facts);
    return { path, meta, body: parsed.body, sha256: topicHash(content), sources, facts,
      state: decision.values.state, action: decision.values.action, cell: decision.cell };
  } catch (error) {
    const facts = { shape: "INVALID", status: "ACTIVE", source: "UNAVAILABLE" };
    const decision = decideMemoryTopic(facts);
    return { path, state: decision.values.state, action: decision.values.action, cell: decision.cell, facts, reason: error.message };
  }
}

/** WHAT: Reads the bounded topic collection without modifying it. WHY: Keeps ordinary search and lint free of model calls or automatic rewrites. */
export function inspectTopics(workspace) {
  const dir = topicDirectory(workspace);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = entries.filter(entry => entry.name.endsWith(".md"));
  if (files.length > 200) throw new Error("topic collection exceeds pilot limit of 200 pages");
  const cache = new Map();
  return files.sort((a, b) => a.name.localeCompare(b.name)).map(entry => inspectTopic(workspace, join(dir, entry.name), { cache }));
}
