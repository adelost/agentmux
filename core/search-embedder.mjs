// Warm semantic lookups for amux search. Loading the model and 100 MB of
// vectors took 2–13 s per CLI call, so semantic search was opt-in and rarely
// used. A small per-user daemon keeps both loaded behind a Unix socket and
// exits after an idle period (30 minutes after the last question), or sooner
// when the machine runs short of free RAM (memoryRoom); the CLI
// never waits for a cold start. When the daemon is not up yet, that one query
// is answered lexically and says so. The daemon also holds the conversation
// log's word index (core/conversation-window.mjs) and answers op conversation.

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexDir, loadEmbedder, semanticModel } from "./search-semantic.mjs";
import { createLiveIndex } from "./search-live-index.mjs";
import { loadReranker } from "./search-rerank.mjs";
import { exitAfterGpu, gpuEnv, gpuReady, reindexRunning } from "./search-gpu.mjs";
import { searchPassages } from "./search-passages.mjs";
import { isTopicPath } from "./memory-topic-search.mjs";
import { acquireFileLease } from "./file-lease.mjs";
import { createEmbedderIdle, embedderIdleMs, embedderLeasePath, embedderMinFreeGb, legacyEmbedderPid } from "./search-embedder-lifecycle.mjs";
import { parseMeminfo } from "./memory-guard.mjs";
import { createConversationWindow } from "./conversation-window.mjs";
import { syncHumanWords } from "./search-human-words.mjs";
import { humanWordsDir } from "./search.mjs";

// Bump for incompatible request/response changes, not for unrelated releases.
// 2: op conversation, answered from the daemon's word index over the conversation log.
const PROTOCOL_VERSION = 2;

const CONNECT_MS = 150;
const DAEMON_HEAP_MB = 1536;
// The daemon's measured peak is 3.81 GB (design §7), so a start needs the floor plus 4 GB: after the load it is still over the floor.
const DAEMON_PEAK_GB = 4;
const MEMORY_CHECK_MS = 30_000;
const KB_PER_GB = 1024 * 1024;
const gbText = (gb) => String(Math.round(gb * 10) / 10);

/**
 * WHAT: Reads MemAvailable of a meminfo file in kB, or null when it cannot be read.
 * WHY: Gives the memory guard one number; a machine without /proc/meminfo runs without the guard instead of failing.
 */
export function readMemAvailableKb(path = "/proc/meminfo") {
  try { return parseMeminfo(readFileSync(path, "utf8")).memAvailableKb; } catch { return null; }
}

/** WHAT: Checks whether needGb of RAM is free; floor 0 or no meminfo means room. WHY: Keeps the search daemon from starting, or staying, when the machine needs its memory. */
export function memoryRoom(needGb, { readAvailableKb = readMemAvailableKb, env = process.env } = {}) {
  // Returns { room, free } in GB; unreadable meminfo gives { room: true, unreadable: true } so the daemon can say the guard is off (design I-4).
  if (embedderMinFreeGb(env) === 0) return { room: true };
  const kb = readAvailableKb();
  if (!Number.isFinite(kb)) return { room: true, unreadable: true };
  const free = kb / KB_PER_GB;
  return { room: free >= needGb, free };
}

/** WHAT: Checks free RAM every 30 s and asks the daemon to close under the floor. WHY: Keeps the daemon from holding RAM the machine needs after the floor is crossed. */
export function watchMemoryFloor({ closeWhenQuiet, readAvailableKb, env = process.env, log = console.warn }) {
  // Under the floor it logs why, once, and calls closeWhenQuiet; it returns the function that stops the check (design I-4, UC-6).
  // The timer is unref'd so a forgotten one never holds the process; readAvailableKb and env are for tests.
  const floor = embedderMinFreeGb(env);
  if (floor === 0) return () => {};
  let saidGuardOff = false, leaving = false;
  const check = () => {
    const memory = memoryRoom(floor, { readAvailableKb, env });
    if (memory.unreadable && !saidGuardOff) { saidGuardOff = true; log("search-embedder: memory guard off: no /proc/meminfo"); }
    if (memory.room || leaving) return;
    leaving = true;
    log(`search-embedder: closing, ${memory.free.toFixed(1)} GB RAM free is under the ${gbText(floor)} GB floor`);
    closeWhenQuiet();
  };
  const timer = setInterval(check, MEMORY_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * WHAT: Names the socket for one index, model and wire protocol.
 * WHY: Keeps incompatible queries separate while compatible releases reuse native weights.
 */
export function embedderSocketPath(dir = indexDir(), model = semanticModel().name) {
  const id = createHash("sha256").update(`${dir}\0${model}\0${PROTOCOL_VERSION}`).digest("hex").slice(0, 12);
  return join(process.env.HOME, ".agentmux", `search-embedder-${id}.sock`);
}

function request(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("embedder timeout")); }, timeoutMs);
    socket.on("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

/** WHAT: Checks whether the search daemon answers. WHY: Keeps a GPU reindex from loading a second model beside the daemon's. */
export async function daemonAlive({ dir = indexDir(), model = semanticModel().name } = {}) {
  return request(embedderSocketPath(dir, model), { ping: true }, CONNECT_MS).then(() => true, () => false);
}

/** WHAT: Schedules the daemon start in the background when free RAM covers its peak. WHY: Keeps the query from waiting on a cold load, and a start from starving the machine. */
export function startEmbedder({ dir = indexDir(), model = semanticModel().name, roots = null, readAvailableKb, env = process.env } = {}) {
  // Without the floor plus the daemon's peak free, the start is refused; readAvailableKb and env are for the memory check's tests.
  const need = embedderMinFreeGb(env) + DAEMON_PEAK_GB;
  const memory = memoryRoom(need, { readAvailableKb, env });
  if (!memory.room) return { unavailable: `${memory.free.toFixed(1)} GB RAM free, the search daemon starts at ${gbText(need)} GB; lexical only this time` };
  const lease = acquireFileLease(embedderLeasePath());
  if (!lease) return { unavailable: "search model owner busy or starting; lexical only this time" };
  let legacyPid;
  try { legacyPid = legacyEmbedderPid(); } finally { lease.release(); }
  if (legacyPid) return { unavailable: `existing search worker ${legacyPid} must finish before upgrade; lexical only this time` };
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "search-embedder.mjs");
  // A bounded V8 heap makes the long-lived daemon collect per-query garbage
  // (rerank inputs, unit scores) instead of growing; golden dev reached 5.3 GB
  // RSS without it against a 4.2 GB budget.
  const child = spawn(process.execPath, [`--max-old-space-size=${DAEMON_HEAP_MB}`, script, "--shared-owner-v1"], {
    detached: true, stdio: "ignore",
    env: { ...(gpuEnv(process.env) || process.env), AMUX_SEARCH_INDEX_DIR: dir, AMUX_SEARCH_MODEL: model,
      ...(Array.isArray(roots) ? { AMUX_SEARCH_WARM_ROOTS: JSON.stringify(roots) } : {}) },
  });
  child.unref();
}

/**
 * WHAT: Returns semantic unit hits from the warm daemon, or why there are none.
 * WHY: Keeps a lexical-only answer from passing as a full search.
 */
export async function semanticQuery(query, { k = 30, roots = null, dir = indexDir(), model = semanticModel().name,
  waitMs = 0, start = startEmbedder } = {}) {
  const socketPath = embedderSocketPath(dir, model);
  const deadline = Date.now() + waitMs;
  let started = false;
  for (;;) {
    try {
      return await request(socketPath, { query, k, roots }, Math.max(CONNECT_MS, 30_000));
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        return { hits: [], unavailable: `semantic daemon error: ${error.message}` };
      }
      if (!started) {
        const startup = start({ dir, model, roots }); started = true;
        if (startup?.unavailable) return { hits: [], unavailable: startup.unavailable };
      }
      if (Date.now() >= deadline) {
        return { hits: [], unavailable: "semantic layer warming up (first query after idle); lexical only this time" };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// The daemon keeps every file's parsed units between queries; a cold caller
// ranks locally instead of waiting.
/**
 * WHAT: Returns note items ranked by the warm daemon, or null when it is down.
 * WHY: Keeps repeated queries from re-parsing the whole corpus.
 */
export async function daemonPassages(query, roots, { max = 30, workspace, dates = [], perFile, dir = indexDir(), model = semanticModel().name } = {}) {
  try {
    const result = await request(embedderSocketPath(dir, model), { op: "passages", query, roots, max, workspace, dates, perFile }, 30_000);
    if (!Array.isArray(result.hits)) return null;
    result.hits.timing = result.timing;
    return result.hits;
  } catch { return null; }
}

/**
 * WHAT: Returns the conversation log's hits from the warm daemon, or null if it cannot answer.
 * WHY: Keeps a question from scanning 238 MB of log; the daemon reads new rows first.
 */
export async function daemonConversation(query, { max = 12, dir = indexDir(), model = semanticModel().name } = {}) {
  try {
    const result = await request(embedderSocketPath(dir, model), { op: "conversation", query, max }, 30_000);
    if (!Array.isArray(result.hits) || result.unavailable) return null;
    result.hits.timing = result.timing;
    result.hits.warning = result.warning;
    return result.hits;
  } catch { return null; }
}

/**
 * WHAT: Returns cross-encoder scores for candidate texts, or null when the daemon is down.
 * WHY: Keeps a cold query from waiting on a model load; it keeps first-stage order instead.
 */
export async function daemonRerank(query, texts, { dir = indexDir(), model = semanticModel().name } = {}) {
  try {
    const result = await request(embedderSocketPath(dir, model), { op: "rerank", query, texts }, 30_000);
    if (Array.isArray(result.scores) && result.scores.length && result.scores.length <= texts.length) {
      return { scores: result.scores, weight: result.weight, kind: result.kind, note: result.note, timing: result.timing };
    }
    return { scores: null, unavailable: result.unavailable || "reranker returned no scores" };
  } catch (error) { return { scores: null, unavailable: `reranker unreachable: ${error.message}` }; }
}

/** WHAT: Builds the passage cache and overlay scan for the roots that started the daemon. WHY: Keeps first-query parsing out of the first answered question. */
export function warmStart(rootsJson, { segments, live, search = searchPassages }) {
  let roots;
  try { roots = JSON.parse(rootsJson || "null"); } catch { return false; }
  if (!Array.isArray(roots) || !roots.length) return false;
  try {
    search("warmup", roots, { max: 1, cache: segments, onWarning: () => {} });
    live.refresh(roots);
    return true;
  } catch { return false; }
}

/** WHAT: Routes semantic and passage queries on a socket until idle. WHY: Keeps model and vectors loaded across CLI calls without a permanent process. */
export async function serveEmbedder({ dir = indexDir(), model = semanticModel(), idleMs = embedderIdleMs(),
  load = loadEmbedder, loadRanking = loadReranker, exit = exitAfterGpu, syncHuman = syncHumanWords } = {}) {
  const lease = acquireFileLease(embedderLeasePath());
  if (!lease) return null;
  try {
    const legacyPid = legacyEmbedderPid();
    if (legacyPid) {
      console.warn(`search-embedder: waiting for existing worker ${legacyPid} to exit; no second model loaded`);
      lease.release();
      return null;
    }
    const server = await serveOwnedEmbedder({ dir, model, idleMs, lease, load, loadRanking, exit, syncHuman });
    if (!server) lease.release();
    return server;
  } catch (error) { lease.release(); throw error; }
}

async function serveOwnedEmbedder({ dir, model, idleMs, lease, load, loadRanking, exit, syncHuman }) {
  const socketPath = embedderSocketPath(dir, model.name);
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    const alive = await request(socketPath, { ping: true }, CONNECT_MS).then(() => true, () => false);
    if (alive) return;
    rmSync(socketPath, { force: true });
  }
  // The conversation window is built from warm start, in the background, beside the model load; the first question
  // about the log waits for it.
  const conversation = createConversationWindow();
  const windowReady = conversation.refresh().catch(() => {});
  const embed = await load(model, { threads: 2 });
  // The reranker loads in the background; until then queries keep the
  // first-stage order instead of waiting. The GPU model is preferred; any
  // reason it is not used is returned with every answer, never hidden.
  let reranker = null;
  let rerankLoading = true;
  let rerankNote = "reranker still loading";
  const loadBestReranker = async () => {
    let note = null;
    if (process.env.AMUX_SEARCH_GPU === "0") note = "GPU disabled (AMUX_SEARCH_GPU=0); CPU reranker in use";
    else if (!gpuReady()) note = "no CUDA libraries (cuDNN or the ONNX Runtime CUDA provider in ~/.cache/agentmux); CPU reranker in use";
    else if (reindexRunning(dir)) note = "GPU busy with a reindex; CPU reranker in use";
    else {
      try { reranker = await loadRanking("gpu"); rerankNote = null; return; }
      catch (error) { note = `GPU reranker unavailable (${String(error.message).split("\n")[0]}); CPU reranker in use`; }
    }
    reranker = await loadRanking("cpu");
    rerankNote = note;
  };
  loadBestReranker().catch((error) => { rerankNote = `reranker failed to load: ${error.message}`; })
    .finally(() => { rerankLoading = false; });
  const rerankInfo = () => reranker ? { kind: reranker.kind, candidates: reranker.candidates, perFile: reranker.perFile, semanticK: reranker.semanticK,
    weight: reranker.weight, note: rerankNote } : { note: rerankNote };
  const segments = new Map();
  const live = createLiveIndex({ dir, embed });
  // His day files are brought up to date when the daemon has not synced yet or a message of his has arrived since, so
  // the passage step of the same question reads them current. A failed sync is tried again by the next question.
  let syncDue = true;
  const answerConversation = async (query, max) => {
    const timing = {};
    let started = performance.now();
    let humanAsks;
    try {
      await windowReady;
      ({ humanAsks } = await conversation.refresh());
    } catch (error) { return { hits: [], unavailable: `conversation window failed: ${error.message}` }; }
    timing["d:conversationTail"] = performance.now() - started;
    started = performance.now();
    let warning;
    if (syncDue || humanAsks) {
      try { syncHuman(); syncDue = false; } catch (error) {
        warning = `his messages could not be copied to ${humanWordsDir()}: ${error.message}`;
      }
    }
    timing["d:humanSync"] = performance.now() - started;
    started = performance.now();
    const hits = conversation.search(query, { max });
    timing["d:conversationSearch"] = performance.now() - started;
    return { hits, timing, ...(warning ? { warning } : {}) };
  };
  let idle;
  // allowHalfOpen: the client half-closes after its request; the answer
  // still has to go back on the same connection.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", async () => {
      let active = false;
      try {
        const { query, k = 30, ping, op, roots, max, workspace, dates = [], texts, perFile } = JSON.parse(data);
        if (ping) { socket.end("{}"); return; }
        idle.begin(); active = true;
        if (op === "rerank") {
          if (!reranker || !Array.isArray(texts)) { socket.end(JSON.stringify({ scores: null, unavailable: rerankNote })); return; }
          const timing = {};
          const scores = await reranker.score(String(query), texts.slice(0, reranker.candidates).map(String), timing);
          socket.end(JSON.stringify({ scores, ...rerankInfo(), timing }));
          return;
        }
        if (op === "conversation") {
          socket.end(JSON.stringify(await answerConversation(String(query), Number(max) || 12)));
          return;
        }
        if (op === "passages") {
          const started = performance.now();
          const hits = searchPassages(String(query), roots, { max, dates, perFile, cache: segments, onWarning: () => {},
            excludePath: (path) => Boolean(workspace) && isTopicPath(path, workspace) });
          socket.end(JSON.stringify({ hits, timing: { "d:bm25": performance.now() - started } }));
          return;
        }
        const loaded = live.index();
        if (!loaded || loaded.model !== model.name) {
          socket.end(JSON.stringify({ hits: [], unavailable: "semantic index missing or built for another model; run: amux search --reindex" }));
          return;
        }
        let started = performance.now();
        if (Array.isArray(roots)) live.refresh(roots);
        const timing = { "d:overlayScan": performance.now() - started };
        started = performance.now();
        const [vector] = await embed([String(query)], "query");
        timing["d:queryEmbed"] = performance.now() - started;
        started = performance.now();
        const hits = live.rank(vector, k);
        timing["d:denseSearch"] = performance.now() - started;
        socket.end(JSON.stringify({ hits, builtAt: loaded.builtAt, complete: loaded.complete,
          pendingFiles: live.pendingFiles(), reranker: rerankInfo(), timing }));
      } catch (error) {
        socket.end(JSON.stringify({ hits: [], unavailable: `semantic query failed: ${error.message}` }));
      } finally {
        if (active) idle.finish();
      }
    });
  });
  idle = createEmbedderIdle({ idleMs, busy: () => rerankLoading || live.pendingFiles() > 0 || conversation.busy(), close: () => server.close() });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  live.index();
  idle.arm();
  const stopMemoryWatch = watchMemoryFloor({ closeWhenQuiet: idle.closeWhenQuiet });
  // Warm start: parse every note and scan for edited files while the
  // reranker loads, so the first real question after an idle exit does not
  // pay for it (it took 9.4 s instead of ~1.5 s).
  setImmediate(() => warmStart(process.env.AMUX_SEARCH_WARM_ROOTS, { segments, live }));
  server.on("close", () => {
    idle.cancel();
    stopMemoryWatch();
    rmSync(socketPath, { force: true });
    lease.release();
    exit(0);
  });
  return server;
}
