// WHAT: Resolves a Claude hook cwd to one configured agent pane and sends a bounded poke.
// WHY: Reactive mirroring is safe only when one Stop signal maps to one pane job, never a global sweep.

import http from "http";
import { readFileSync } from "fs";
import { resolve, join, sep } from "path";
import yaml from "js-yaml";

export function loadAgentsConfig(path) {
  return yaml.load(readFileSync(path, "utf-8")) || {};
}

export function cwdFromHookInput(input, fallback = process.cwd()) {
  if (!input || typeof input !== "object") return fallback;
  return input.cwd
    || input.workspace?.current_dir
    || input.workspace?.cwd
    || fallback;
}

export function resolvePaneFromCwd(cwd, config) {
  if (!cwd || !config || typeof config !== "object") return null;
  const current = normalizePath(cwd);
  const candidates = [];

  for (const [name, entry] of Object.entries(config)) {
    if (!entry?.dir || !Array.isArray(entry.panes)) continue;
    const root = normalizePath(entry.dir);
    const paneCount = entry.panes.length;

    for (let pane = 1; pane < paneCount; pane++) {
      const paneRoot = normalizePath(join(root, ".agents", String(pane)));
      if (pathContains(paneRoot, current)) {
        candidates.push({ name, pane, dir: root, score: paneRoot.length + 1000 });
      }
    }

    const agentsRoot = normalizePath(join(root, ".agents"));
    if (pathContains(agentsRoot, current)) {
      candidates.push({ blocked: true, score: agentsRoot.length + 900 });
      continue;
    }

    if (pathContains(root, current) && !pathContains(agentsRoot, current)) {
      candidates.push({ name, pane: 0, dir: root, score: root.length });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best?.blocked) return null;
  return best ? { name: best.name, pane: best.pane, dir: best.dir } : null;
}

export function pokePath({ name, pane }) {
  return `/api/poke/${encodeURIComponent(name)}/${encodeURIComponent(String(pane))}`;
}

export function sendReactivePoke({ host = "127.0.0.1", port, name, pane, timeoutMs = 800 }) {
  return new Promise((resolvePromise) => {
    if (!port || !name || !Number.isInteger(Number(pane))) {
      resolvePromise({ ok: false, statusCode: null, error: "missing poke target" });
      return;
    }

    const req = http.request({
      host,
      port,
      method: "POST",
      path: pokePath({ name, pane }),
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on("end", () => {
        resolvePromise({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolvePromise({ ok: false, statusCode: null, error: "timeout" });
    });
    req.on("error", (err) => {
      resolvePromise({ ok: false, statusCode: null, error: err.message });
    });
    req.end();
  });
}

function normalizePath(path) {
  return resolve(String(path)).replace(/[\\/]+$/, "");
}

function pathContains(root, candidate) {
  return candidate === root || candidate.startsWith(root + sep);
}
