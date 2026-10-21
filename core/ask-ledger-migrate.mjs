import { createHash, randomUUID } from "node:crypto";
import { createReadStream, appendFileSync, closeSync, fsyncSync, mkdirSync, openSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDailyLedger, legacyLedgerFiles } from "./ask-ledger-paths.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function* lines(path) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    pending = Buffer.concat([pending, chunk]);
    let start = 0;
    for (let end; (end = pending.indexOf(10, start)) >= 0; start = end + 1) yield pending.subarray(start, end + 1);
    pending = pending.subarray(start);
  }
  if (pending.length) throw Error(`ledger-import-incomplete-line: ${path}`);
}

function dayOf(line, path) {
  let row;
  try { row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
  catch { return null; }
  const ms = Date.parse(row?.ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// WHAT: Returns a verified daily import without replacing native appends. WHY: Prevents migration or a restarted pass from losing content, doubling copied rows or hiding a changing legacy writer.
export async function migrateDailyLedger(path, { apply = false, progress = () => {} } = {}) {
  if (!isDailyLedger(path)) throw Error("daily import needs a directory target");
  const files = legacyLedgerFiles(path), existing = new Map(), seen = new Map(), buffers = new Map();
  const days = {}, sources = [];
  let sourceRows = 0, sourceBytes = 0, writtenRows = 0, locked = false;
  const lock = join(path, "import.lock");
  if (apply) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 }); locked = true;
  }
  try {
    let names = [];
    try { names = readdirSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name) || name === "legacy-unassigned.jsonl")) {
      for await (const line of lines(join(path, name))) {
        const day = dayOf(line, name);
        if (day !== (name === "legacy-unassigned.jsonl" ? null : name.slice(0, 10))) throw Error(`ledger-import-wrong-day: ${name}`);
        const key = hash(line); existing.set(key, (existing.get(key) || 0) + 1);
      }
    }
    const flush = day => {
      const buffer = buffers.get(day);
      if (buffer?.bytes && apply) appendFileSync(join(path, `${day}.jsonl`), Buffer.concat(buffer.rows), { mode: 0o600 });
      buffers.delete(day);
    };
    for (const file of files) {
      const before = statSync(file), digest = createHash("sha256");
      let rows = 0, bytes = 0;
      for await (const line of lines(file)) {
        // Old malformed/undated bytes remain explicit; assigning them a date would invent provenance.
        const day = dayOf(line, file) || "legacy-unassigned", key = hash(line);
        digest.update(line); rows++; bytes += line.length;
        days[day] = (days[day] || 0) + 1;
        const count = (seen.get(key) || 0) + 1; seen.set(key, count);
        if (count <= (existing.get(key) || 0)) continue;
        writtenRows++;
        if (apply) {
          const buffer = buffers.get(day) || { rows: [], bytes: 0 };
          buffer.rows.push(line); buffer.bytes += line.length; buffers.set(day, buffer);
          if (buffer.bytes >= 1024 * 1024) flush(day);
        }
      }
      const after = statSync(file);
      if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Error(`ledger-import-source-changed: ${file}`);
      sources.push({ path: file, bytes, mtimeMs: after.mtimeMs, sha256: digest.digest("hex"), rows });
      sourceRows += rows; sourceBytes += bytes;
      progress({ files: sources.length, sourceRows, sourceBytes });
    }
    if (apply) {
      for (const day of buffers.keys()) flush(day);
      for (const day of Object.keys(days)) {
        const fd = openSync(join(path, `${day}.jsonl`), "a", 0o600);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      for (const source of sources) {
        const current = statSync(source.path);
        if (current.size !== source.bytes || current.mtimeMs !== source.mtimeMs) throw Error(`ledger-import-source-changed: ${source.path}`);
      }
      const manifest = join(path, `legacy-import.${randomUUID()}.tmp`), fd = openSync(manifest, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, sources, sourceRows, sourceBytes, days }) + "\n"); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(manifest, join(path, "legacy-import.json"));
      const directory = openSync(path, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { apply, sourceRows, sourceBytes, writtenRows, unassignedRows: days["legacy-unassigned"] || 0, days, sources, originalsRetained: true };
  } finally {
    if (locked) rmSync(lock, { recursive: true });
  }
}
