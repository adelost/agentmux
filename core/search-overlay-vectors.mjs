// The live overlay's vectors, kept between daemon starts. The overlay lived only in the daemon's memory, so every
// cold start embedded everything written since the nightly build again: 776 units and about 20 core minutes on the
// evening of 14 Nov 2026, twice within an hour when the memory floor closed the daemon.
//
// One file beside the index (overlay-vectors.bin): a header line naming the build, model and dimension the vectors
// belong to, then fixed records of a unit hash and its vector. A new build holds the day's units itself, so its
// header differs and the file starts over; it never holds more than one build's overlay.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HASH_BYTES = 16;

/**
 * `get(hash)` returns a saved vector or undefined; `add(hash, vector)` keeps one for the next start.
 * WHAT: Loads the saved overlay vectors of one index build.
 * WHY: Keeps a restarted daemon from embedding again what an earlier start already embedded.
 */
export function openOverlayVectors({ dir, builtAt, model, dimension, warn = console.warn }) {
  // A file that cannot be read or written is said once and the overlay carries on in memory, as before this file existed.
  const path = join(dir, "overlay-vectors.bin");
  const header = `${JSON.stringify({ builtAt, model, dimension })}\n`;
  const recordBytes = HASH_BYTES + dimension * 4;
  let writable = true;
  const unsaved = (error) => {
    if (writable) warn(`search-embedder: overlay vectors are not kept between starts: ${error.message}`);
    writable = false;
  };
  let vectors;
  try {
    vectors = savedVectors(path, header, recordBytes);
    if (!vectors) writeFileSync(path, header, { mode: 0o600 });
  } catch (error) { unsaved(error); }
  vectors ||= new Map();
  return {
    get: (hash) => vectors.get(hash),
    add(hash, vector) {
      const row = Float32Array.from(vector);
      if (hash.length !== HASH_BYTES || row.length !== dimension || vectors.has(hash)) return;
      vectors.set(hash, row);
      if (!writable) return;
      const record = Buffer.alloc(recordBytes);
      record.write(hash, 0, HASH_BYTES, "latin1");
      Buffer.from(row.buffer).copy(record, HASH_BYTES);
      try { appendFileSync(path, record); } catch (error) { unsaved(error); }
    },
  };
}

// The vectors of a file written for this header, or null when there is none to continue: no file, another build,
// model or dimension, or a last record cut short by a kill. Appending after a cut record would shift every later one.
function savedVectors(path, header, recordBytes) {
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const body = Buffer.byteLength(header);
  if (bytes.toString("utf8", 0, body) !== header || (bytes.length - body) % recordBytes) return null;
  const vectors = new Map();
  for (let at = body; at < bytes.length; at += recordBytes) {
    const from = bytes.byteOffset + at + HASH_BYTES;
    vectors.set(bytes.toString("latin1", at, at + HASH_BYTES), new Float32Array(bytes.buffer.slice(from, from + recordBytes - HASH_BYTES)));
  }
  return vectors;
}
