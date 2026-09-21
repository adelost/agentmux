import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { isRecord, requireValue, sha256 } from './contract.mjs';

/** WHAT: Projects existing canonical config into one Qwen worker per actual repo directory.
 * WHY: No new counts are inserted before existing pane/service indices; legacy config remains byte-identical.
 * Missing `qwen` means enabled for this experiment (one per repo); `qwen: 0` explicitly opts an alias out.
 */
export function planQwenFleet(document, { home = homedir(), resolveDirectory = (p) => {
  const real = realpathSync(p);
  requireValue(statSync(real).isDirectory(), 'BAD_REPO', 'Configured repo is not a directory.');
  return real;
} } = {}) {
  requireValue(isRecord(document) && isRecord(document.agents), 'BAD_CONFIG', 'Expected canonical agentmux.yaml with an agents object, not generated agents.yaml.');
  const byDirectory = new Map();
  for (const [name, entry] of Object.entries(document.agents)) {
    requireValue(name.length > 0 && name.length <= 160 && !name.includes('\0') && isRecord(entry), 'BAD_AGENT', 'Malformed agent configuration.');
    requireValue(typeof entry.dir === 'string' && entry.dir.length > 0 && !entry.dir.includes('\0'), 'BAD_REPO', 'Every configured agent needs a directory.');
    const expanded = entry.dir === '~' ? home : entry.dir.startsWith('~/') ? join(home, entry.dir.slice(2)) : entry.dir;
    requireValue(isAbsolute(expanded), 'RELATIVE_REPO', 'Repository paths must be absolute or ~/ paths; no shell expansion is performed.');
    requireValue(entry.qwen == null || entry.qwen === 0 || entry.qwen === 1, 'QWEN_COUNT_CONFLICT', 'Qwen count must be 0 or 1 for this bounded experiment.');
    requireValue(entry.backend == null || ['tmux', 'native'].includes(entry.backend), 'BAD_BACKEND', 'Unknown existing backend.');
    requireValue(entry.qwen !== 0 || entry.qwenModel == null, 'QWEN_DISABLED_CONFIG', 'qwenModel cannot be set on an alias that explicitly opts out with qwen: 0.');
    if (entry.qwen === 0) continue;
    const cwd = resolveDirectory(resolve(expanded));
    requireValue(typeof cwd === 'string' && isAbsolute(cwd), 'BAD_REPO', 'Resolver must return an absolute directory.');
    let worker = byDirectory.get(cwd);
    if (!worker) {
      worker = { workerId: `qwen-${sha256(cwd)}`, engine: 'qwen', instances: 1,
        cwd, aliases: [], configuredModel: null, backend: 'bounded-cli', existingFleetUntouched: true };
      byDirectory.set(cwd, worker);
    }
    if (entry.qwenModel != null) {
      requireValue(typeof entry.qwenModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(entry.qwenModel), 'BAD_MODEL', 'Invalid qwenModel in source configuration.');
      requireValue(worker.configuredModel === null || worker.configuredModel === entry.qwenModel, 'MODEL_CONFLICT', 'Same repository has conflicting Qwen model selections.');
      worker.configuredModel = entry.qwenModel;
    }
    worker.aliases.push(name);
  }
  return [...byDirectory.values()].map((worker) => ({ ...worker, aliases: worker.aliases.sort() }))
    .sort((a, b) => a.cwd.localeCompare(b.cwd));
}
export function selectQwenWorker(workers, alias) {
  const matches = workers.filter((w) => w.workerId === alias || w.aliases.includes(alias));
  requireValue(matches.length === 1, 'TARGET_UNKNOWN', 'The requested repo must identify exactly one configured Qwen worker.');
  return matches[0];
}
