import { unit, feature, expect } from "bdd-vitest";
import { createState } from "./state.mjs";
import {
  closeSync, mkdirSync, openSync, readFileSync, readSync, rmdirSync, statSync, unlinkSync,
  utimesSync, writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpPath = () => join(tmpdir(), `agentmux-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const cleanup = (path) => {
  try { unlinkSync(path); } catch {}
  try { rmdirSync(`${path}.lock`); } catch {}
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));

const readWholeFd = (fd) => {
  const buffer = Buffer.alloc(64 * 1024);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  return buffer.subarray(0, length).toString("utf-8");
};

// Another (older) writer truncates the file in place: the newer mtime makes a
// reader reload while the file is empty.
const truncateInPlace = (path) => {
  writeFileSync(path, "");
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
};

const captureError = (work) => {
  try { work(); return null; } catch (error) { return error; }
};

feature("createState", () => {
  unit("get returns fallback for missing key", {
    given: ["a fresh state", () => { const p = tmpPath(); return { state: createState(p), path: p }; }],
    when: ["getting missing key", ({ state }) => state.get("foo", "default")],
    then: ["returns fallback", (val, { path }) => {
      expect(val).toBe("default");
      cleanup(path);
    }],
  });

  unit("set persists value", {
    given: ["a fresh state", () => { const p = tmpPath(); return { state: createState(p), path: p }; }],
    when: ["setting a value", ({ state }) => { state.set("tts", true); return state.get("tts"); }],
    then: ["value is stored", (val, { path }) => {
      expect(val).toBe(true);
      cleanup(path);
    }],
  });

  unit("toggle flips boolean", {
    given: ["state with tts=false", () => {
      const p = tmpPath();
      const s = createState(p);
      s.set("tts", false);
      return { state: s, path: p };
    }],
    when: ["toggling tts", ({ state }) => state.toggle("tts")],
    then: ["tts is now true", (val, { path }) => {
      expect(val).toBe(true);
      cleanup(path);
    }],
  });

  unit("toggle defaults false→true for missing key", {
    given: ["a fresh state", () => { const p = tmpPath(); return { state: createState(p), path: p }; }],
    when: ["toggling missing key", ({ state }) => state.toggle("foo")],
    then: ["becomes true", (val, { path }) => {
      expect(val).toBe(true);
      cleanup(path);
    }],
  });

  unit("survives reload from disk", {
    given: ["state with saved value", () => {
      const p = tmpPath();
      const s1 = createState(p);
      s1.set("name", "agentmux");
      return { path: p };
    }],
    when: ["creating new state from same file", ({ path }) => createState(path).get("name")],
    then: ["value survives", (val, { path }) => {
      expect(val).toBe("agentmux");
      cleanup(path);
    }],
  });

  unit("remove deletes key", {
    given: ["state with a key", () => {
      const p = tmpPath();
      const s = createState(p);
      s.set("x", 42);
      return { state: s, path: p };
    }],
    when: ["removing key", ({ state }) => { state.remove("x"); return state.get("x"); }],
    then: ["key is gone", (val, { path }) => {
      expect(val).toBeUndefined();
      cleanup(path);
    }],
  });

  unit("all returns copy of state", {
    given: ["state with two keys", () => {
      const p = tmpPath();
      const s = createState(p);
      s.set("a", 1);
      s.set("b", 2);
      return { state: s, path: p };
    }],
    when: ["getting all", ({ state }) => state.all()],
    then: ["returns both keys", (all, { path }) => {
      expect(all).toEqual({ a: 1, b: 2 });
      cleanup(path);
    }],
  });

  unit("writes valid JSON to disk", {
    given: ["state with value", () => {
      const p = tmpPath();
      const s = createState(p);
      s.set("key", "value");
      return { path: p };
    }],
    when: ["reading file directly", ({ path }) => JSON.parse(readFileSync(path, "utf-8"))],
    then: ["valid JSON with key", (data, { path }) => {
      expect(data.key).toBe("value");
      cleanup(path);
    }],
  });

  unit("a reader that opened the file before a save still reads the complete previous version", {
    given: ["a saved state and a reader holding the file open", () => {
      const path = tmpPath();
      const state = createState(path);
      state.set("a", "old");
      const before = readFileSync(path, "utf-8");
      return { path, state, before, fd: openSync(path, "r") };
    }],
    when: ["another value is saved", ({ state, fd }) => {
      state.set("a", "new");
      const held = readWholeFd(fd);
      closeSync(fd);
      return held;
    }],
    then: ["the open file is untouched and the path holds the new version", (held, { path, before }) => {
      expect(held).toBe(before);
      expect(readJson(path).a).toBe("new");
      cleanup(path);
    }],
  });

  unit("a reload that catches another writer mid-write retries instead of seeing an empty state", {
    given: ["a state whose file another writer is rewriting in place", () => {
      const path = tmpPath();
      writeFileSync(path, JSON.stringify({ a: 1, b: 2 }));
      let pauses = 0;
      const sleep = () => {
        pauses += 1;
        if (pauses === 1) writeFileSync(path, JSON.stringify({ a: 1, b: 2, c: 3 }));
      };
      const state = createState(path, { sleep });
      truncateInPlace(path);
      return { path, state };
    }],
    when: ["the state is read and then written", ({ state }) => {
      const a = state.get("a");
      state.set("d", 4);
      return a;
    }],
    then: ["no key is lost", (a, { path }) => {
      expect(a).toBe(1);
      expect(readJson(path)).toEqual({ a: 1, b: 2, c: 3, d: 4 });
      cleanup(path);
    }],
  });

  unit("an existing file that does not parse refuses to load and is left as it is", {
    given: ["a torn state file", () => {
      const path = tmpPath();
      writeFileSync(path, '{"a": 1, "b"');
      return { path };
    }],
    when: ["a state store is created on it", ({ path }) => captureError(() => createState(path, { sleep: () => {} }))],
    then: ["it fails loud and the file is unchanged", (error, { path }) => {
      expect(error?.name).toBe("StateFileError");
      expect(readFileSync(path, "utf-8")).toBe('{"a": 1, "b"');
      cleanup(path);
    }],
  });

  unit("a set while the file stays torn fails instead of saving one key over every other", {
    given: ["a loaded state whose file is then truncated by another writer", () => {
      const path = tmpPath();
      writeFileSync(path, JSON.stringify({ a: 1, b: 2 }));
      const state = createState(path, { sleep: () => {} });
      truncateInPlace(path);
      return { path, state };
    }],
    when: ["one key is set", ({ state }) => captureError(() => state.set("k", "v"))],
    then: ["the set throws and the file is not replaced by {k}", (error, { path }) => {
      expect(error?.name).toBe("StateFileError");
      expect(readFileSync(path, "utf-8")).toBe("");
      cleanup(path);
    }],
  });

  unit("two stores on one file keep each other's keys even within one timestamp tick", {
    given: ["store B loaded, then store A writes again inside the same mtime tick", () => {
      // Linux stamps mtime from a coarse clock, so two writes a few ms apart
      // can carry the identical mtime. Pin it to one exact second to make
      // that deterministic.
      const path = tmpPath();
      const tick = 1_700_000_000;
      const a = createState(path);
      a.set("a", 1);
      utimesSync(path, tick, tick);
      const b = createState(path);
      a.set("x", 2);
      utimesSync(path, tick, tick);
      return { path, b };
    }],
    when: ["store B sets its own key", ({ b }) => b.set("b", 3)],
    then: ["the file holds every key", (_, { path }) => {
      expect(readJson(path)).toEqual({ a: 1, x: 2, b: 3 });
      cleanup(path);
    }],
  });

  unit("a set waits while another process holds the state lock", {
    given: ["a lock held by another process that releases it on the first pause", () => {
      const path = tmpPath();
      const state = createState(path, {
        sleep: () => { pauses += 1; try { rmdirSync(`${path}.lock`); } catch {} },
      });
      let pauses = 0;
      mkdirSync(`${path}.lock`);
      return { path, state, pauses: () => pauses };
    }],
    when: ["a key is set", ({ state }) => state.set("k", "v")],
    then: ["it waited for the lock and then saved", (_, { path, pauses }) => {
      expect(pauses()).toBeGreaterThan(0);
      expect(readJson(path)).toEqual({ k: "v" });
      cleanup(path);
    }],
  });

  unit("a lock that never frees fails the set after the timeout without writing", {
    given: ["a fresh lock held by a live process and a clock that runs out", () => {
      const path = tmpPath();
      let clock = 0;
      const state = createState(path, { sleep: () => { clock += 1_000; }, now: () => clock, lockTimeoutMs: 3_000 });
      mkdirSync(`${path}.lock`);
      return { path, state };
    }],
    when: ["a key is set", ({ state }) => captureError(() => state.set("k", "v"))],
    then: ["it throws and no state file appears", (error, { path }) => {
      expect(String(error?.message)).toMatch(/stayed busy/u);
      expect(() => statSync(path)).toThrow();
      cleanup(path);
    }],
  });

  unit("a save keeps the file's private mode", {
    given: ["a state file with mode 0600", () => {
      const path = tmpPath();
      writeFileSync(path, JSON.stringify({ a: 1 }), { mode: 0o600 });
      return { path, state: createState(path) };
    }],
    when: ["a key is set", ({ state }) => state.set("b", 2)],
    then: ["the mode is still 0600", (_, { path }) => {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      cleanup(path);
    }],
  });
});
