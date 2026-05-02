// Persistent key-value state backed by a JSON file.
// Survives process restarts (unlike in-memory variables).
// Detects external file edits (e.g. `amux tts` from a different process)
// via mtime check — picks up the new value on the next get().

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { dirname } from "path";

const load = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
};

const save = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

const mtimeMs = (path) => {
  try { return statSync(path).mtimeMs; } catch { return 0; }
};

/**
 * Create a persistent state store.
 * @param {string} path - file path for the JSON state file
 */
export const createState = (path) => {
  let data = load(path);
  let lastMtime = mtimeMs(path);

  // If the file was modified externally since our last read or write,
  // refresh the in-memory copy. This is what lets `amux tts` flip a value
  // and have a long-running bridge process notice on the next state.get().
  const maybeReload = () => {
    const m = mtimeMs(path);
    if (m && m > lastMtime) {
      data = load(path);
      lastMtime = m;
    }
  };

  const get = (key, fallback = undefined) => {
    maybeReload();
    return key in data ? data[key] : fallback;
  };

  const set = (key, value) => {
    maybeReload(); // do not clobber an external write that landed first
    data[key] = value;
    save(path, data);
    lastMtime = mtimeMs(path);
    return value;
  };

  const toggle = (key) => set(key, !get(key, false));

  const remove = (key) => {
    maybeReload();
    delete data[key];
    save(path, data);
    lastMtime = mtimeMs(path);
  };

  const all = () => { maybeReload(); return { ...data }; };

  return { get, set, toggle, remove, all };
};
