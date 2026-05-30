// WHAT: Small pane job scheduler with per-pane coalescing, per-pane locks,
//       global concurrency, and failure backoff.
// WHY: Runtime signals can arrive in bursts from fs.watch, polling, and later
//      reactive pokes. The queue prevents hot loops and "all panes at once"
//      overload while keeping domain policy out of adapters.
// DOES NOT: Know about JSONL, Discord, checkpoints, tmux, or config formats.

export function createPaneQueue({
  worker,
  maxConcurrency = 4,
  backoffMs = 30_000,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  log = () => {},
} = {}) {
  if (typeof worker !== "function") throw new Error("pane queue: worker required");

  const queued = new Map();
  const active = new Set();
  const pendingAfterActive = new Map();
  const backoffUntil = new Map();
  const timers = new Map();
  let activeCount = 0;
  let idleResolvers = [];

  function enqueue(key, job = {}) {
    if (!key) throw new Error("pane queue: key required");

    if (active.has(key)) {
      pendingAfterActive.set(key, mergeJob(pendingAfterActive.get(key), job));
      return { status: "coalesced-active" };
    }

    const until = backoffUntil.get(key) || 0;
    if (until > now()) {
      queueAfterBackoff(key, job, until);
      return { status: "delayed", untilMs: until };
    }

    queued.set(key, mergeJob(queued.get(key), job));
    drain();
    return { status: "queued" };
  }

  function queueAfterBackoff(key, job, untilMs) {
    queued.set(key, mergeJob(queued.get(key), job));
    if (timers.has(key)) return;
    const delayMs = Math.max(0, untilMs - now());
    const timer = setTimer(() => {
      timers.delete(key);
      drain();
    }, delayMs);
    timers.set(key, timer);
  }

  function drain() {
    while (activeCount < maxConcurrency && queued.size > 0) {
      const [key, job] = queued.entries().next().value;
      queued.delete(key);

      const until = backoffUntil.get(key) || 0;
      if (until > now()) {
        queueAfterBackoff(key, job, until);
        continue;
      }

      start(key, job);
    }
    maybeResolveIdle();
  }

  function start(key, job) {
    active.add(key);
    activeCount++;

    Promise.resolve()
      .then(() => worker({ key, ...job }))
      .then((result = {}) => {
        if (result.retryAfterMs && result.retryAfterMs > 0) {
          const until = now() + result.retryAfterMs;
          backoffUntil.set(key, until);
        } else {
          backoffUntil.delete(key);
        }
      })
      .catch((err) => {
        const until = now() + backoffMs;
        backoffUntil.set(key, until);
        log(`pane queue worker failed for ${key}: ${err.message || err}`);
      })
      .finally(() => {
        active.delete(key);
        activeCount--;
        const pending = pendingAfterActive.get(key);
        if (pending) {
          pendingAfterActive.delete(key);
          enqueue(key, pending);
        }
        drain();
      });
  }

  function isIdle() {
    return activeCount === 0 && queued.size === 0 && pendingAfterActive.size === 0;
  }

  function maybeResolveIdle() {
    if (!isIdle()) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const r of resolvers) r();
  }

  function onIdle() {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  function stop() {
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    queued.clear();
    pendingAfterActive.clear();
    maybeResolveIdle();
  }

  function stats() {
    return {
      queued: queued.size,
      active: activeCount,
      pending: pendingAfterActive.size,
      backoff: backoffUntil.size,
    };
  }

  return {
    enqueue,
    onIdle,
    stop,
    stats,
    _backoffUntil: backoffUntil,
  };
}

function mergeJob(prev, next) {
  return { ...(prev || {}), ...(next || {}) };
}
