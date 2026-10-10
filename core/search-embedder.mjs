// Warm semantic lookups for amux search. Loading the model and 100 MB of
// vectors took 2–13 s per CLI call, so semantic search was opt-in and rarely
// used. A small per-user daemon keeps both loaded behind a Unix socket and
// exits after an idle period; the CLI never waits for a cold start. When the
// daemon is not up yet, that one query is answered lexically and says so.

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexDir, loadEmbedder, semanticModel } from "./search-semantic.mjs";
import { createLiveIndex } from "./search-live-index.mjs";
import { loadReranker } from "./search-rerank.mjs";
import { exitAfterGpu, gpuEnv, gpuReady, reindexRunning } from "./search-gpu.mjs";
import { searchPassages } from "./search-passages.mjs";
import { isTopicPath } from "./memory-topic-search.mjs";
import { createRequire } from "node:module";

const VERSION = createRequire(import.meta.url)("../package.json").version;

const IDLE_MS = () => (Number(process.env.AMUX_EMBEDDER_IDLE_MIN) || 30) * 60_000;
const CONNECT_MS = 150;
const DAEMON_HEAP_MB = 1536;

// A new release never talks to a daemon still running the previous code.
/**
 * WHAT: Names the socket for one index, model and amux version.
 * WHY: Keeps one index, model or release from answering another's queries.
 */
export function embedderSocketPath(dir = indexDir(), model = semanticModel().name) {
  const id = createHash("sha256").update(`${dir}\0${model}\0${VERSION}`).digest("hex").slice(0, 12);
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

/** WHAT: Schedules the daemon start in the background. WHY: Keeps the current query from waiting on a cold model load. */
export function startEmbedder({ dir = indexDir(), model = semanticModel().name } = {}) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "search-embedder.mjs");
  // A bounded V8 heap makes the long-lived daemon collect per-query garbage
  // (rerank inputs, unit scores) instead of growing; golden dev reached 5.3 GB
  // RSS without it against a 4.2 GB budget.
  const child = spawn(process.execPath, [`--max-old-space-size=${DAEMON_HEAP_MB}`, script], {
    detached: true, stdio: "ignore",
    env: { ...(gpuEnv(process.env) || process.env), AMUX_SEARCH_INDEX_DIR: dir, AMUX_SEARCH_MODEL: model },
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
      if (!started) { start({ dir, model }); started = true; }
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

/** WHAT: Routes semantic and passage queries on a socket until idle. WHY: Keeps model and vectors loaded across CLI calls without a permanent process. */
export async function serveEmbedder({ dir = indexDir(), model = semanticModel(), idleMs = IDLE_MS() } = {}) {
  const socketPath = embedderSocketPath(dir, model.name);
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    const alive = await request(socketPath, { ping: true }, CONNECT_MS).then(() => true, () => false);
    if (alive) return;
    rmSync(socketPath, { force: true });
  }
  const embed = await loadEmbedder(model, { threads: 2 });
  // The reranker loads in the background; until then queries keep the
  // first-stage order instead of waiting. The GPU model is preferred; any
  // reason it is not used is returned with every answer, never hidden.
  let reranker = null;
  let rerankNote = "reranker still loading";
  const loadBestReranker = async () => {
    let note = null;
    if (process.env.AMUX_SEARCH_GPU === "0") note = "GPU disabled (AMUX_SEARCH_GPU=0); CPU reranker in use";
    else if (!gpuReady()) note = "no CUDA libraries (cuDNN or the ONNX Runtime CUDA provider in ~/.cache/agentmux); CPU reranker in use";
    else if (reindexRunning(dir)) note = "GPU busy with a reindex; CPU reranker in use";
    else {
      try { reranker = await loadReranker("gpu"); rerankNote = null; return; }
      catch (error) { note = `GPU reranker unavailable (${String(error.message).split("\n")[0]}); CPU reranker in use`; }
    }
    reranker = await loadReranker("cpu");
    rerankNote = note;
  };
  loadBestReranker().catch((error) => { rerankNote = `reranker failed to load: ${error.message}`; });
  const rerankInfo = () => reranker ? { kind: reranker.kind, candidates: reranker.candidates, perFile: reranker.perFile, semanticK: reranker.semanticK,
    weight: reranker.weight, note: rerankNote } : { note: rerankNote };
  const segments = new Map();
  const live = createLiveIndex({ dir, embed });
  let idleTimer;
  // allowHalfOpen: the client half-closes after its request; the answer
  // still has to go back on the same connection.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clearTimeout(idleTimer);
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", async () => {
      try {
        const { query, k = 30, ping, op, roots, max, workspace, dates = [], texts, perFile } = JSON.parse(data);
        if (ping) { socket.end("{}"); return; }
        if (op === "rerank") {
          if (!reranker || !Array.isArray(texts)) { socket.end(JSON.stringify({ scores: null, unavailable: rerankNote })); return; }
          const timing = {};
          const scores = await reranker.score(String(query), texts.slice(0, reranker.candidates).map(String), timing);
          socket.end(JSON.stringify({ scores, ...rerankInfo(), timing }));
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
        idleTimer = setTimeout(() => server.close(), idleMs);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  live.index();
  idleTimer = setTimeout(() => server.close(), idleMs);
  server.on("close", () => {
    rmSync(socketPath, { force: true });
    exitAfterGpu(0);
  });
}
