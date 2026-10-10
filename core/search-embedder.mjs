// Warm semantic lookups for amux search. Loading the model and 100 MB of
// vectors took 2–13 s per CLI call, so semantic search was opt-in and rarely
// used. A small per-user daemon keeps both loaded behind a Unix socket and
// exits after an idle period; the CLI never waits for a cold start. When the
// daemon is not up yet, that one query is answered lexically and says so.

import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexDir, loadEmbedder, openIndex, rankUnits, semanticModel } from "./search-semantic.mjs";
import { searchPassages } from "./search-passages.mjs";
import { isTopicPath } from "./memory-topic-search.mjs";
import { createRequire } from "node:module";

const VERSION = createRequire(import.meta.url)("../package.json").version;

const IDLE_MS = () => (Number(process.env.AMUX_EMBEDDER_IDLE_MIN) || 30) * 60_000;
const CONNECT_MS = 150;

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

/** WHAT: Schedules the daemon start in the background. WHY: Keeps the current query from waiting on a cold model load. */
export function startEmbedder({ dir = indexDir(), model = semanticModel().name } = {}) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "search-embedder.mjs");
  const child = spawn(process.execPath, [script], {
    detached: true, stdio: "ignore",
    env: { ...process.env, AMUX_SEARCH_INDEX_DIR: dir, AMUX_SEARCH_MODEL: model },
  });
  child.unref();
}

/**
 * WHAT: Returns semantic unit hits from the warm daemon, or why there are none.
 * WHY: Keeps a lexical-only answer from passing as a full search.
 */
export async function semanticQuery(query, { k = 30, dir = indexDir(), model = semanticModel().name,
  waitMs = 0, start = startEmbedder } = {}) {
  const socketPath = embedderSocketPath(dir, model);
  const deadline = Date.now() + waitMs;
  let started = false;
  for (;;) {
    try {
      return await request(socketPath, { query, k }, Math.max(CONNECT_MS, 30_000));
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
export async function daemonPassages(query, roots, { max = 30, workspace, dir = indexDir(), model = semanticModel().name } = {}) {
  try {
    const result = await request(embedderSocketPath(dir, model), { op: "passages", query, roots, max, workspace }, 30_000);
    return Array.isArray(result.hits) ? result.hits : null;
  } catch { return null; }
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
  const segments = new Map();
  const metaPath = join(dir, "meta.json");
  let index = null;
  let indexMtime = 0;
  const currentIndex = () => {
    const mtime = existsSync(metaPath) ? statSync(metaPath).mtimeMs : 0;
    if (mtime !== indexMtime) {
      index = openIndex(dir);
      indexMtime = mtime;
    }
    return index;
  };
  let idleTimer;
  // allowHalfOpen: the client half-closes after its request; the answer
  // still has to go back on the same connection.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    clearTimeout(idleTimer);
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", async () => {
      try {
        const { query, k = 30, ping, op, roots, max, workspace } = JSON.parse(data);
        if (ping) { socket.end("{}"); return; }
        if (op === "passages") {
          const hits = searchPassages(String(query), roots, { max, cache: segments, onWarning: () => {},
            excludePath: (path) => Boolean(workspace) && isTopicPath(path, workspace) });
          socket.end(JSON.stringify({ hits }));
          return;
        }
        const loaded = currentIndex();
        if (!loaded || loaded.model !== model.name) {
          socket.end(JSON.stringify({ hits: [], unavailable: "semantic index missing or built for another model; run: amux search --reindex" }));
          return;
        }
        const [vector] = await embed([String(query)], "query");
        socket.end(JSON.stringify({ hits: rankUnits(loaded, vector, { k }), builtAt: loaded.builtAt, complete: loaded.complete }));
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
  currentIndex();
  idleTimer = setTimeout(() => server.close(), idleMs);
  server.on("close", () => rmSync(socketPath, { force: true }));
}
