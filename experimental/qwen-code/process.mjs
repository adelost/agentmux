import { spawn, execFile } from 'node:child_process';
import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { QwenError, QwenTurnReader, requireValue, validatePrompt } from './contract.mjs';

export function resolveQwenExecutable({ explicit = null, env = process.env } = {}) {
  const paths = explicit === null ? String(env.PATH ?? '').split(delimiter).filter(Boolean).map((p) => join(p, 'qwen')) : [explicit];
  for (const candidate of paths) {
    requireValue(typeof candidate === 'string' && isAbsolute(candidate), 'BAD_EXECUTABLE', 'Executable/PATH entry must be absolute.');
    try { const real = realpathSync(candidate); accessSync(real, constants.X_OK); if (statSync(real).isFile()) return real; }
    catch { /* another PATH candidate may exist */ }
  }
  throw new QwenError('QWEN_MISSING', 'Qwen executable not found. Install/authenticate Qwen Code locally first.');
}

export function runQwenProcess(spec, prompt, { signal, spawnImpl = spawn, timeoutMs = (spec.wallSeconds + 5) * 1000,
  killGraceMs = 1500 } = {}) {
  validatePrompt(prompt);
  requireValue(signal == null || signal instanceof AbortSignal, 'BAD_SIGNAL', 'Cancellation needs an AbortSignal.');
  if (signal?.aborted) return Promise.reject(new QwenError('CANCELLED', 'Cancelled before launch.'));
  return new Promise((resolve, reject) => {
    const reader = new QwenTurnReader({ expectedSession: spec.resumeSessionId, expectedModel: spec.requestedModel });
    let child, failure = null, closed = false, killTimer, watchdog;
    const signalOwned = (sig) => {
      if (!child?.pid || closed) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); }
      catch (e) { if (e.code !== 'ESRCH') failure ??= new QwenError('SIGNAL_FAILED', 'Unable to stop owned Qwen process.'); }
    };
    const stop = (error) => {
      if (closed) return;
      failure ??= error; signalOwned('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => signalOwned('SIGKILL'), killGraceMs);
    };
    const cancel = () => stop(new QwenError('CANCELLED', 'Qwen cancelled; side effects may already have occurred.'));
    const cleanup = () => { clearTimeout(watchdog); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); };
    try {
      child = spawnImpl(spec.executable, [...spec.args], {
        cwd: spec.cwd, env: process.env, shell: false,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(new QwenError('SPAWN_FAILED', 'Qwen could not be spawned.')); return; }
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > 2 * 1024 * 1024) stop(new QwenError('STDERR_LIMIT', 'Qwen stderr exceeded the safety limit.')); });
    child.stdout.on('data', (chunk) => { if (failure) return; try { reader.push(chunk); } catch (e) { stop(e); } });
    child.stdin.on('error', () => { failure ??= new QwenError('INPUT_FAILED', 'Qwen input pipe failed; turn outcome must be checked.'); });
    child.on('error', () => { failure ??= new QwenError('SPAWN_FAILED', 'Qwen could not be started. Check executable and local authentication.'); });
    child.on('close', (exitCode, exitSignal) => {
      closed = true; cleanup();
      if (failure) { reject(failure); return; }
      try { resolve(reader.finish(exitCode, exitSignal)); } catch (e) { reject(e); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    watchdog = setTimeout(() => stop(new QwenError('TIMEOUT', 'Qwen exceeded its deadline; no retry or fresh session was started.')), timeoutMs);
    if (signal?.aborted) cancel();
    child.stdin.end(prompt);
  });
}

function execText(executable, args, execFileImpl) {
  return new Promise((resolve, reject) => execFileImpl(executable, args,
    { timeout: 8000, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false, killSignal: 'SIGKILL' },
    (error, stdout) => error ? reject(new QwenError('CLI_PROBE_FAILED', `Qwen ${args.join(' ')} failed. No work was submitted.`)) : resolve(String(stdout))));
}

export async function probeQwenExecutable(executable, { execFileImpl = execFile } = {}) {
  requireValue(typeof executable === 'string' && isAbsolute(executable), 'BAD_EXECUTABLE', 'Use an absolute executable path.');
  const [help, versionOutput] = await Promise.all([
    execText(executable, ['--help'], execFileImpl),
    execText(executable, ['--version'], execFileImpl),
  ]);
  const requiredFlags = ['--input-format', '--output-format', '--approval-mode', '--resume', '--max-session-turns', '--max-tool-calls', '--max-wall-time', '--exclude-tools'];
  const missingFlags = requiredFlags.filter((flag) => !new RegExp(`${flag}(?=[\\s=,\\[]|$)`, 'u').test(help));
  const versionMatch = versionOutput.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)(?:\s|$)/u);
  return { engine: 'qwen', compatible: missingFlags.length === 0 && Boolean(versionMatch), missingFlags,
    version: versionMatch?.[1] ?? null,
    nestedAgentsDisabled: true,
    evidence: 'Local executable --help/--version only, not provider authentication or a completed model turn.' };
}
