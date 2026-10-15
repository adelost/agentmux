import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedderIdle, legacyEmbedderPid } from "./search-embedder-lifecycle.mjs";

const model = vi.hoisted(() => ({ version: "before-release", load: vi.fn(), score: vi.fn(), exit: vi.fn() }));
vi.mock("node:module", async original => {
  const actual = await original();
  return { ...actual, createRequire: url => new Proxy(actual.createRequire(url), {
    apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args);
      return args[0] === "../package.json" ? { ...value, version: model.version } : value;
    },
  }) };
});
vi.mock("./search-semantic.mjs", async original => ({ ...await original(), loadEmbedder: model.load }));
vi.mock("./search-rerank.mjs", () => ({ loadReranker: async () => ({ score: model.score, candidates: 30, weight: 1, kind: "fixture" }) }));
vi.mock("./search-gpu.mjs", async original => ({ ...await original(), exitAfterGpu: model.exit }));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let home, dir;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "embedder-life-")); dir = join(home, "index");
  vi.stubEnv("HOME", home); vi.stubEnv("AMUX_SEARCH_GPU", "0"); vi.stubEnv("AMUX_SEARCH_WARM_ROOTS", "");
  model.load.mockReset().mockResolvedValue(async () => [[1]]);
  model.score.mockReset().mockResolvedValue([1]); model.exit.mockReset();
});
afterEach(async () => { await delay(60); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("one warm search model owner", () => {
  it("distinguishes an old live worker from new lease contenders without stopping either", () => {
    const proc = join(home, "proc");
    for (const [pid, marker] of [[101, false], [102, true]]) {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), "cmdline"), ["node", "/package/bin/search-embedder.mjs", ...(marker ? ["--shared-owner-v1"] : [])].join("\0"));
      writeFileSync(join(proc, String(pid), "environ"), `HOME=${home}\0`);
    }
    expect(legacyEmbedderPid({ proc })).toBe(101);
    rmSync(join(proc, "101"), { recursive: true });
    expect(legacyEmbedderPid({ proc })).toBe(null);
  });
  it("waits for both active requests and background index work before idle exit", () => {
    vi.useFakeTimers();
    let busy = true;
    const close = vi.fn();
    const idle = createEmbedderIdle({ idleMs: 25, busy: () => busy, close });
    try {
      idle.begin(); idle.begin(); idle.finish();
      vi.advanceTimersByTime(100); expect(close).not.toHaveBeenCalled();
      idle.finish(); vi.advanceTimersByTime(100); expect(close).not.toHaveBeenCalled();
      busy = false; vi.advanceTimersByTime(25); expect(close).toHaveBeenCalledTimes(1);
    } finally { idle.cancel(); vi.useRealTimers(); }
  });
  it("reuses the same protocol endpoint across compatible package releases", async () => {
    model.version = "old"; vi.resetModules();
    const old = await import("./search-embedder.mjs");
    model.version = "new"; vi.resetModules();
    const fresh = await import("./search-embedder.mjs");
    expect(fresh.embedderSocketPath(dir, "model")).toBe(old.embedderSocketPath(dir, "model"));
  });
  it("claims the only owner before either concurrent caller loads native weights", async () => {
    vi.resetModules(); const api = await import("./search-embedder.mjs");
    let release;
    const loaded = new Promise(resolve => { release = resolve; });
    model.load.mockImplementation(() => loaded);
    const first = api.serveEmbedder({ dir, idleMs: 20 });
    await delay(5);
    const second = api.serveEmbedder({ dir, idleMs: 20 });
    try { await delay(10); expect(model.load).toHaveBeenCalledTimes(1); }
    finally { release(async () => [[1]]); await Promise.allSettled([first, second]); }
  });
  it("does not close its listener while another request is still scoring", async () => {
    vi.resetModules(); const api = await import("./search-embedder.mjs");
    let release, began;
    const started = new Promise(resolve => { began = resolve; });
    const scoring = new Promise(resolve => { release = resolve; });
    model.score.mockImplementation(async () => { began(); await scoring; return [1]; });
    await api.serveEmbedder({ dir, idleMs: 25 });
    const result = api.daemonRerank("question", ["a source"], { dir });
    await started;
    try {
      expect(await api.daemonAlive({ dir })).toBe(true);
      await delay(60);
      expect(await api.daemonAlive({ dir })).toBe(true);
    } finally { release(); await result; }
    await delay(60);
    expect(await api.daemonAlive({ dir })).toBe(false);
    expect(model.exit).toHaveBeenCalledTimes(1);
  });
});
