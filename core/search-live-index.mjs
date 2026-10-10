// Today's note changes all day, but the semantic index is rebuilt at night.
// The search daemon keeps a small overlay: files edited or created since the
// index was built are re-embedded in the background, reusing the vectors of
// units whose text did not change, and ranking reads the overlay in their
// place once a file is done.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileUnits, indexDir, listMarkdownFiles, openIndex, rankUnits } from "./search-semantic.mjs";

const SCAN_EVERY_MS = 30_000;
const MAX_UNITS_PER_SCAN = 4_000;
const BATCH = 4;

/**
 * WHAT: Builds a semantic index view that follows edits made after the nightly build.
 * WHY: Keeps today's and yesterday's notes from being invisible to paraphrase search until night.
 */
export function createLiveIndex({ dir = indexDir(), embed, listFiles = listMarkdownFiles, now = Date.now,
  scanEveryMs = SCAN_EVERY_MS, maxUnitsPerScan = MAX_UNITS_PER_SCAN } = {}) {
  const metaPath = join(dir, "meta.json");
  const overlay = new Map();
  let base = null;
  let baseMtime = -1;
  let baseFiles = new Map();
  let byHash = null;
  let lastScan = -Infinity;
  let queue = [];
  let running = null;

  const current = () => {
    const mtime = existsSync(metaPath) ? statSync(metaPath).mtimeMs : 0;
    if (mtime !== baseMtime) {
      base = openIndex(dir);
      baseMtime = mtime;
      baseFiles = new Map((base?.meta || []).map((file) => [file.file, file]));
      byHash = null;
      for (const [file, entry] of overlay) {
        const indexed = baseFiles.get(file);
        if (indexed && indexed.mtimeMs === entry.mtimeMs && indexed.size === entry.size) overlay.delete(file);
      }
    }
    return base;
  };

  const vectorByHash = () => {
    if (!byHash) {
      byHash = new Map();
      base?.units.forEach(({ unit }, row) => { if (unit.hash) byHash.set(unit.hash, row); });
    }
    return byHash;
  };

  const scan = (roots) => {
    if (!current() || now() - lastScan < scanEveryMs) return;
    lastScan = now();
    const queued = new Set(queue.map((item) => item.file));
    for (const root of roots.filter((candidate) => candidate.semantic)) {
      for (const file of listFiles(root)) {
        let stat;
        try { stat = statSync(file); } catch { continue; }
        const indexed = baseFiles.get(file);
        if (indexed && indexed.mtimeMs === stat.mtimeMs && indexed.size === stat.size) { overlay.delete(file); continue; }
        const live = overlay.get(file);
        if ((live && live.mtimeMs === stat.mtimeMs && live.size === stat.size) || queued.has(file)) continue;
        queue.push({ file, root });
        queued.add(file);
      }
    }
  };

  const embedFile = async ({ file, root }, budget) => {
    const stat = statSync(file);
    const units = fileUnits(file, readFileSync(file, "utf8"));
    const dim = base.dimension;
    const previous = overlay.get(file);
    const known = new Map(previous ? previous.units.map((unit, i) => [unit.hash, previous.vectors.subarray(i * dim, (i + 1) * dim)]) : []);
    const vectors = new Float32Array(units.length * dim);
    const missing = [];
    units.forEach((unit, i) => {
      const row = vectorByHash().get(unit.hash);
      const reuse = known.get(unit.hash) || (row === undefined ? null : base.vectors.subarray(row * dim, (row + 1) * dim));
      if (reuse) vectors.set(reuse, i * dim);
      else missing.push(i);
    });
    if (missing.length > budget) return missing.length;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const embedded = await embed(batch.map((index) => units[index].embedText), "passage");
      batch.forEach((index, k) => vectors.set(embedded[k], index * dim));
      // Yield so queries keep being answered while a large file embeds.
      await new Promise((resolve) => setImmediate(resolve));
    }
    overlay.set(file, { file, mtimeMs: stat.mtimeMs, size: stat.size, root: root.name, weight: root.weight,
      units: units.map(({ embedText, ...unit }) => unit), vectors });
    return missing.length;
  };

  const work = async () => {
    let budget = maxUnitsPerScan;
    while (queue.length && budget > 0) {
      const item = queue.shift();
      try { budget -= await embedFile(item, budget); } catch { /* removed or unreadable: the next scan decides */ }
    }
    queue = [];
  };

  return {
    /** WHAT: Schedules re-embedding of files changed since the build. WHY: Keeps queries from waiting on embedding. */
    refresh(roots) {
      scan(roots);
      if (!running && queue.length) running = work().finally(() => { running = null; });
      return running || Promise.resolve();
    },
    /** WHAT: Returns the top-k units across the index and the overlay. WHY: Keeps edited files ranked by their current text. */
    rank(vector, k) {
      const index = current();
      return index ? rankUnits(index, vector, { k, overlay }) : null;
    },
    index: current,
    pendingFiles: () => queue.length + (running ? 1 : 0),
  };
}
