#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DEFAULT_APPROVAL_MODE, QwenError, requireValue, sha256 } from './contract.mjs';
import { planQwenFleet, selectQwenWorker } from './fleet.mjs';
import { resolveQwenExecutable, probeQwenExecutable } from './process.mjs';
import { runQwenWorker } from './worker.mjs';

const HELP = `Qwen Code bounded AMUX command (not yet a tmux pane/broker engine).

  amux qwen --doctor [--executable /absolute/path/to/qwen]
  amux qwen --plan [--config FILE]
  amux qwen --repo ai --message-file task.txt \\
    --request-id task-001 --execute --allow-provider --bootstrap

Default config: ~/.agentmux/agentmux.yaml. --plan only reads it.
No config edits, pane renumbering, sync, restarts, API-key changes or batch launches.
Every configured repo is included by default; source-config qwen: 0 explicitly opts that alias out.
First run requires --bootstrap. Later runs resume the exact stored Qwen session.
--execute --allow-provider explicitly permits the local Qwen client to use its configured provider.
--approval-mode default|plan|auto-edit|auto|yolo (default: auto).
Qwen nested agent/list_agents tools are always excluded: AMUX remains the orchestrator and the tool budget stays inspectable.
Optional: --executable /absolute/path/to/qwen --state-dir /absolute/private/dir
          --max-turns 40 --max-tool-calls 80 --wall-seconds 600
An existing/uncertain request is never automatically retried. Reuse the same request id
only to retrieve a completed receipt. A verified completion with permission denials is
persisted once, printed as outcome=completed_with_denials, and exits 2 rather than being
silently reported as a clean success. Do not put credentials in arguments or the repo.
`;
async function boundedFile(path, cap) {
  const stat = await lstat(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap, 'BAD_FILE', 'Expected a regular, bounded local file, not a symlink.');
  const bytes = await readFile(path);
  requireValue(bytes.length <= cap, 'BAD_FILE', 'Local file changed beyond the byte limit.');
  return bytes;
}
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, loadYaml, defaultConfigPath } = {}) {
  try {
    if (!argv.length || argv.length === 1 && argv[0] === '--help') { stdout.write(HELP); return 0; }
    const switches = new Set(['--doctor', '--plan', '--execute', '--allow-provider', '--bootstrap']);
    const values = new Set(['--config', '--repo', '--message-file', '--request-id', '--approval-mode', '--executable', '--state-dir', '--max-turns', '--max-tool-calls', '--wall-seconds']);
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      requireValue((switches.has(flag) || values.has(flag)) && !Object.hasOwn(opts, flag), 'USAGE', 'Unknown/repeated option. See --help.');
      if (switches.has(flag)) opts[flag] = true;
      else { const value = argv[++i]; requireValue(value && !value.startsWith('--'), 'USAGE', 'Option requires a value.'); opts[flag] = value; }
    }
    if (opts['--doctor']) {
      requireValue(Object.keys(opts).every((k) => ['--doctor', '--executable'].includes(k)), 'USAGE', 'Doctor accepts only --executable.');
      const report = await probeQwenExecutable(resolveQwenExecutable({ explicit: opts['--executable'] ?? null }));
      stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.compatible ? 0 : 1;
    }
    const configPath = resolve(opts['--config'] ?? defaultConfigPath ?? join(homedir(), '.agentmux', 'agentmux.yaml'));
    requireValue(Boolean(opts['--plan']) !== Boolean(opts['--execute']), 'USAGE', 'Choose --plan OR --execute.');
    if (opts['--plan']) requireValue(Object.keys(opts).every((k) => ['--plan', '--config'].includes(k)), 'USAGE', 'Plan mode accepts only --config.');
    const bytes = await boundedFile(configPath, 2 * 1024 * 1024);
    // Reuse AMUX's existing YAML parser dependency; no second parser/runtime is introduced.
    const parse = loadYaml ?? (await import('js-yaml')).load;
    let doc; try { doc = parse(bytes.toString('utf8')); } catch { throw new QwenError('BAD_YAML', 'Config YAML could not be parsed; content withheld.'); }
    const workers = planQwenFleet(doc);
    if (opts['--plan']) {
      stdout.write(`${JSON.stringify({ mode: 'plan-only', activeConfigChanged: false, providerCalls: 0,
        configSha256: sha256(bytes), workers }, null, 2)}\n`); return 0;
    }
    requireValue(opts['--allow-provider'] === true, 'PROVIDER_CONSENT', 'Execution requires --allow-provider; a configured provider can incur cost and receive repo content.');
    requireValue(opts['--repo'] && opts['--message-file'] && opts['--request-id'], 'USAGE', 'Execution requires --repo, --message-file and --request-id.');
    const worker = selectQwenWorker(workers, opts['--repo']);
    const prompt = (await boundedFile(resolve(opts['--message-file']), 128 * 1024)).toString('utf8');
    const executable = resolveQwenExecutable({ explicit: opts['--executable'] ?? null });
    const abort = new AbortController(), stop = () => abort.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await runQwenWorker(worker, { prompt, requestId: opts['--request-id'], executable,
        bootstrap: opts['--bootstrap'] === true, approvalMode: opts['--approval-mode'] ?? DEFAULT_APPROVAL_MODE,
        maxTurns: Number(opts['--max-turns'] ?? 40), maxToolCalls: Number(opts['--max-tool-calls'] ?? 80),
        wallSeconds: Number(opts['--wall-seconds'] ?? 600), signal: abort.signal,
        stateRoot: opts['--state-dir'] ? resolve(opts['--state-dir']) : undefined });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.outcome === 'completed' ? 0 : 2;
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } catch (e) {
    const safe = e instanceof QwenError ? e : new QwenError('LOCAL_ERROR', 'Local operation failed; no raw file/provider data printed.');
    stderr.write(`${JSON.stringify({ status: 'blocked', code: safe.code, message: safe.message })}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
