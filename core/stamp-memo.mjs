// Facts derived only from a file's bytes, kept per file stamp.
// On 27 Oct the bridge re-derived them on every poll: the Codex busy verdict
// (20 % of its main thread) and the Claude limit receipt (17 %).

/**
 * WHAT: Builds a store of one value per key, valid while the file keeps its stamp.
 * WHY: Keeps an unchanged journal or rollout from being read again; a changed one is always read.
 */
export function createStampMemo(maxEntries = 256) {
  const entries = new Map(); // key → { stamp, value }
  const stampOf = (stat) => `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  return {
    get(key, stat) {
      const known = entries.get(key);
      return known && stat && known.stamp === stampOf(stat) ? known.value : undefined;
    },
    set(key, stat, value) {
      if (!stat) return value;
      entries.delete(key);
      entries.set(key, { stamp: stampOf(stat), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
