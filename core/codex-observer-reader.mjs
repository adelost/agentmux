import { codexSessionDirs } from "./codex-profiles.mjs";
import { captureCodexSessionCatalog, directoryStamp } from "./codex-session-catalog.mjs";
import { latestCodexJsonlInfo, latestCodexJsonlMtime, readLastTurnsCodex } from "./codex-jsonl-reader.mjs";

/** WHAT: Builds a bounded observation reader. WHY: Prevents repeated archive discovery while preserving independent physical delivery resolution. */
export function createCodexObserverReader({ roots = codexSessionDirs, capture = captureCodexSessionCatalog,
  stamp = directoryStamp, now = () => performance.now(), maxAgeMs = 250 } = {}) {
  let cached = null, key = null, until = 0;
  const options = () => {
    const dirs = roots(), currentKey = JSON.stringify(dirs);
    if (!cached || key !== currentKey || now() >= until
      || cached.directories.some(dir => stamp(dir.path) !== dir.stamp)) {
      cached = capture(dirs); key = currentKey; until = now() + maxAgeMs;
    }
    return { sessionCatalog: cached.files };
  };
  return {
    latestInfo: dir => latestCodexJsonlInfo(dir, options()),
    latestMtime: dir => latestCodexJsonlMtime(dir, options()),
    readTurns: (dir, opts) => readLastTurnsCodex(dir, { ...opts, ...options() }),
  };
}

/** WHAT: Names the shared observation reader. WHY: Keeps typing and response observations on one bounded discovery view. */
export const codexObserverReader = createCodexObserverReader();
