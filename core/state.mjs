// Persistent key-value state backed by a JSON file.
// Survives process restarts (unlike in-memory variables).

import { readFileSync, writeFileSync, mkdirSync } from "fs";
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

/**
 * Create a persistent state store.
 * @param {string} path - file path for the JSON state file
 */
export const createState = (path) => {
  let data = load(path);

  const get = (key, fallback = undefined) =>
    key in data ? data[key] : fallback;

  const set = (key, value) => {
    data[key] = value;
    save(path, data);
    return value;
  };

  const toggle = (key) => set(key, !get(key, false));

  const remove = (key) => {
    delete data[key];
    save(path, data);
  };

  const all = () => ({ ...data });

  return { get, set, toggle, remove, all };
};
