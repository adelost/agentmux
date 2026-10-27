import { Worker } from "node:worker_threads";

/** WHAT: Checks citations off the input event loop. WHY: Keeps Git and file I/O from delaying human delivery. */
export function createClaimEvaluator(repos, { timeoutMs = 5000 } = {}) {
  let worker = null, sequence = 0;
  const pending = new Map();
  function fail(error) {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    if (worker) { void worker.terminate(); worker = null; }
  }
  return text => new Promise((resolve, reject) => {
    if (!worker) {
      // Bridge preloads own services and cannot run in an isolated source checker.
      worker = new Worker(new URL("./claim-worker.mjs", import.meta.url), {
        workerData: { repos }, execArgv: [], env: { ...process.env, NODE_OPTIONS: "" },
      });
      worker.on("message", ({ id, result, error }) => {
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id); clearTimeout(call.timer);
        if (error) call.reject(Error(error)); else call.resolve(result);
      });
      worker.on("error", fail);
      worker.unref();
    }
    const id = ++sequence;
    const timer = setTimeout(() => fail(Error("claim source validation exceeded5s; unverified")), timeoutMs);
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, text });
  });
}
