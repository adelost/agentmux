import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedderIdle, embedderIdleMs, legacyEmbedderPid } from "./search-embedder-lifecycle.mjs";

const model = vi.hoisted(() => ({ version: "before-release", load: vi.fn(), score: vi.fn(), exit: vi.fn(), spawn: vi.fn() }));
// A start that gets past its checks must not launch a real daemon from a test.
vi.mock("node:child_process", async original => ({ ...await original(), spawn: model.spawn }));
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
  model.spawn.mockReset().mockReturnValue({ unref: () => {} });
});
afterEach(async () => { await delay(60); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("one warm search model owner", () => {
  it("stays loaded for 30 minutes after the last question unless AMUX_EMBEDDER_IDLE_MIN says otherwise", () => {
    expect(embedderIdleMs({})).toBe(30 * 60_000);
    expect(embedderIdleMs({ AMUX_EMBEDDER_IDLE_MIN: "2" })).toBe(2 * 60_000);
    expect(embedderIdleMs({ AMUX_EMBEDDER_IDLE_MIN: "0.5" })).toBe(30_000);
    expect(embedderIdleMs({ AMUX_EMBEDDER_IDLE_MIN: "nonsense" })).toBe(30 * 60_000);
  });
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

// The memory guard (design I-4): the daemon starts only with room for its peak, and leaves when the machine runs short.
// The tests inject the meminfo reader and run on fake timers: no daemon, model or socket. Two run a real serveEmbedder
// with fake loaders, and say so.
describe("the search daemon's memory guard", () => {
  // Fake timers are dropped even when a test fails halfway, so the file's own afterEach can still wait.
  afterEach(() => { vi.useRealTimers(); });
  const embedder = () => import("./search-embedder.mjs");
  const kb = gb => Math.round(gb * 1024 * 1024); // MemAvailable as /proc/meminfo reports it
  const SECOND = 1000;

  it("does not start without room for its peak", async () => {
    const { startEmbedder } = await embedder();
    const logPath = join(home, "search-embedder.log");
    // The default floor is 8 GB. The daemon peaks at 3.8 GB and its conversation window adds 0.5 GB (design §4, R-7),
    // so a start needs the floor plus 5 GB: 13 GB free.
    expect(startEmbedder({ dir, env: {}, readAvailableKb: () => kb(6.2), logPath })).toEqual({
      unavailable: "6.2 GB RAM free, the search daemon starts at 13 GB; lexical only this time",
    });
    expect(startEmbedder({ dir, env: {}, readAvailableKb: () => kb(12), logPath })?.unavailable).toMatch(/starts at 13 GB/);
    expect(model.spawn).not.toHaveBeenCalled();
    expect(startEmbedder({ dir, env: {}, readAvailableKb: () => kb(13), logPath })).toBeUndefined();
    expect(model.spawn).toHaveBeenCalledTimes(1);
  });

  it("reports the owner as busy, not memory, while another process loads", async () => {
    const { startEmbedder, serveEmbedder } = await embedder();
    // A daemon takes the lease before its model loads, and the loading is what lowers MemAvailable. It is a real
    // serveEmbedder with a fake loader that stays pending, so the lease is held by the code that holds it in production.
    let finishLoading;
    model.load.mockImplementation(() => new Promise(resolve => { finishLoading = resolve; }));
    const loading = serveEmbedder({ dir, idleMs: 20 });
    await vi.waitFor(() => expect(model.load).toHaveBeenCalledTimes(1));
    try {
      expect(startEmbedder({ dir, env: {}, readAvailableKb: () => kb(6.2), logPath: join(home, "search-embedder.log") })).toEqual({
        unavailable: "search model owner busy or starting; lexical only this time",
      });
      expect(model.spawn).not.toHaveBeenCalled();
    } finally {
      finishLoading(async () => [[1]]);
      await loading;
    }
  });

  it("closes when free memory falls under the floor", async () => {
    const { watchMemoryFloor } = await embedder();
    vi.useFakeTimers();
    let freeGb = 20;
    const close = vi.fn(), log = vi.fn();
    // Background index work is running: the guard does not wait for it, only for a question in flight.
    const idle = createEmbedderIdle({ idleMs: 30 * 60 * SECOND, busy: () => true, close });
    idle.arm();
    const stop = watchMemoryFloor({ closeWhenQuiet: idle.closeWhenQuiet, readAvailableKb: () => kb(freeGb), env: {}, log });
    vi.advanceTimersByTime(5 * 30 * SECOND);
    expect(close).not.toHaveBeenCalled();
    freeGb = 7.4;
    vi.advanceTimersByTime(30 * SECOND);
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["search-embedder: closing, 7.4 GB RAM free is under the 8 GB floor"]]);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the question in flight before it closes for memory", async () => {
    const { watchMemoryFloor } = await embedder();
    vi.useFakeTimers();
    const close = vi.fn(), log = vi.fn();
    const idle = createEmbedderIdle({ idleMs: 30 * 60 * SECOND, close });
    watchMemoryFloor({ closeWhenQuiet: idle.closeWhenQuiet, readAvailableKb: () => kb(7.4), env: {}, log });
    idle.begin();
    vi.advanceTimersByTime(3 * 30 * SECOND);
    expect(close).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    idle.finish();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("the daemon closes for memory through serveEmbedder", async () => {
    const { serveEmbedder, daemonAlive, readMemAvailableKb } = await embedder();
    // A real serveEmbedder with fake loaders. Its guard reads the host's own /proc/meminfo, so the floor is set above
    // any machine's RAM and the daemon is under it at the first check.
    expect(readMemAvailableKb(), "this test needs a readable /proc/meminfo").toBeGreaterThan(0);
    vi.stubEnv("AMUX_EMBEDDER_MIN_FREE_GB", "1000000");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The reranker never finishes loading: the close for memory does not wait for background loading (design §6).
    const server = await serveEmbedder({ dir, idleMs: 60 * 60 * SECOND, loadRanking: () => new Promise(() => {}) });
    try {
      expect(await daemonAlive({ dir })).toBe(true);
      await vi.advanceTimersByTimeAsync(30 * SECOND);
      await vi.waitFor(() => expect(model.exit).toHaveBeenCalledWith(0), { timeout: 3000 });
      expect(await daemonAlive({ dir })).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("search-embedder: closing"));
    } finally {
      warn.mockRestore();
      if (server.listening) server.close();
    }
  });

  it("a floor of 0 turns the guard off", async () => {
    const { startEmbedder, watchMemoryFloor } = await embedder();
    const env = { AMUX_EMBEDDER_MIN_FREE_GB: "0" };
    const scarce = () => kb(0.5);
    expect(startEmbedder({ dir, env, readAvailableKb: scarce, logPath: join(home, "search-embedder.log") })).toBeUndefined();
    expect(model.spawn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    const closeWhenQuiet = vi.fn();
    watchMemoryFloor({ closeWhenQuiet, readAvailableKb: scarce, env, log: vi.fn() });
    vi.advanceTimersByTime(60 * 60 * SECOND);
    expect(closeWhenQuiet).not.toHaveBeenCalled();
  });

  it("takes memory it cannot read as room, and says once that the guard is off", async () => {
    const { memoryRoom, readMemAvailableKb, watchMemoryFloor } = await embedder();
    const unreadable = () => readMemAvailableKb(join(home, "no-such-meminfo"));
    expect(memoryRoom(12, { readAvailableKb: unreadable, env: {} }).room).toBe(true);
    vi.useFakeTimers();
    const closeWhenQuiet = vi.fn(), log = vi.fn();
    watchMemoryFloor({ closeWhenQuiet, readAvailableKb: unreadable, env: {}, log });
    vi.advanceTimersByTime(5 * 30 * SECOND);
    expect(closeWhenQuiet).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["search-embedder: memory guard off: no /proc/meminfo"]]);
  });
});

// The daemon's stderr is kept in ~/.agentmux/search-embedder.log (design §2 and §6). `stdio: "ignore"` lost every line,
// including the one that says why the daemon closed for memory. Each test gives startEmbedder a log path in its own HOME.
describe("the search daemon's log", () => {
  const MIB = 1024 * 1024;
  const guardOff = { AMUX_EMBEDDER_MIN_FREE_GB: "0" }; // the log is under test here, not the memory check
  const logPath = () => join(home, "search-embedder.log");
  // The fake spawn stands in for the daemon. As with a real child, a line on its stderr lands where the parent pointed
  // it, and is lost when the parent ignored it.
  const daemonSays = line => model.spawn.mockImplementation((_exe, _args, { stdio }) => {
    if (Array.isArray(stdio) && typeof stdio[2] === "number") writeSync(stdio[2], `${line}\n`);
    return { unref: () => {} };
  });

  it("keeps the daemon's log and moves it aside past 1 MiB", async () => {
    const { startEmbedder } = await import("./search-embedder.mjs");
    const start = line => { daemonSays(line); return startEmbedder({ dir, env: guardOff, logPath: logPath() }); };
    writeFileSync(logPath(), "x".repeat(MIB)); // exactly 1 MiB is not past it
    writeFileSync(`${logPath()}.1`, "an older log");
    expect(start("search-embedder: first")).toBeUndefined();
    expect(statSync(logPath()).size).toBe(MIB + "search-embedder: first\n".length);
    expect(readFileSync(`${logPath()}.1`, "utf8")).toBe("an older log");
    expect(start("search-embedder: second")).toBeUndefined();
    expect(readFileSync(logPath(), "utf8")).toBe("search-embedder: second\n");
    expect(statSync(`${logPath()}.1`).size).toBe(MIB + "search-embedder: first\n".length);
    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
  });

  it("says why, and answers lexically, when the log cannot be opened", async () => {
    const { startEmbedder } = await import("./search-embedder.mjs");
    writeFileSync(join(home, "a-file"), ""); // the log's folder is a file
    expect(startEmbedder({ dir, env: guardOff, logPath: join(home, "a-file", "search-embedder.log") })?.unavailable)
      .toMatch(/^the search daemon's log could not be opened \(.+\); lexical only this time$/);
    expect(model.spawn).not.toHaveBeenCalled();
  });

  it("lets go of its own copy of the log once the daemon has it", async () => {
    const { startEmbedder } = await import("./search-embedder.mjs");
    let given;
    model.spawn.mockImplementation((_exe, _args, { stdio }) => { given = Array.isArray(stdio) ? stdio[2] : stdio; return { unref: () => {} }; });
    expect(startEmbedder({ dir, env: guardOff, logPath: logPath() })).toBeUndefined();
    expect(given).toEqual(expect.any(Number)); // the daemon's stderr is a descriptor on the log
    expect(() => fstatSync(given)).toThrow(/EBADF/); // and the parent has closed its copy
  });
});
