import { closeSync, openSync, readSync, statSync } from "node:fs";

/** WHAT: Checks whether one file's bytes start the other's. WHY: An append-only rollout copied to another account stays a prefix of the copy that keeps growing. */
export function isBytePrefix(older, newer, { bytes = statSync(older).size } = {}) {
  const size = bytes;
  if (!Number.isSafeInteger(size) || size < 0 || size > statSync(older).size || size > statSync(newer).size) return false;
  const left = openSync(older, "r"), right = openSync(newer, "r");
  const a = Buffer.alloc(64 * 1024), b = Buffer.alloc(64 * 1024);
  try {
    for (let offset = 0; offset < size; offset += a.length) {
      const count = Math.min(a.length, size - offset);
      if (readSync(left, a, 0, count, offset) !== count || readSync(right, b, 0, count, offset) !== count
          || !a.subarray(0, count).equals(b.subarray(0, count))) return false;
    }
    return true;
  } finally { closeSync(left); closeSync(right); }
}
