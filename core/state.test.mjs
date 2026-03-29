import { unit, feature, expect } from "bdd-vitest";
import { createState } from "./state.mjs";
import { unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpPath = () => join(tmpdir(), `agentus-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const cleanup = (path) => { try { unlinkSync(path); } catch {} };

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
      s1.set("name", "agentus");
      return { path: p };
    }],
    when: ["creating new state from same file", ({ path }) => createState(path).get("name")],
    then: ["value survives", (val, { path }) => {
      expect(val).toBe("agentus");
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
});
